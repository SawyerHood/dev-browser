import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileLogger } from "../../src/shared/log.ts";
import { connectCdp, defaultChromeUserDataDirs, resolveCdpEndpoint } from "../../src/daemon/sources/cdp.ts";

let dir: string;
let log: FileLogger;
const messages: string[] = [];
const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-browser-discovery-"));
  const previousHome = process.env.DEV_BROWSER_HOME;
  process.env.DEV_BROWSER_HOME = dir;
  cleanup.push(() => {
    if (previousHome === undefined) delete process.env.DEV_BROWSER_HOME;
    else process.env.DEV_BROWSER_HOME = previousHome;
  });
  messages.length = 0;
  log = { info: (message: string) => messages.push(message), warn: (message: string) => messages.push(message) } as unknown as FileLogger;
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Minimal browser CDP endpoint: no real Chrome, consent prompt or user profile. */
function endpoint(options: { version?: boolean; rejectWebSocket?: boolean; rejectCdp?: boolean } = {}) {
  const requests: string[] = [];
  const methods: string[] = [];
  const browserPath = "/devtools/browser/test-browser";
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server) {
      const pathname = new URL(req.url).pathname;
      requests.push(pathname);
      if (pathname === browserPath && !options.rejectWebSocket && server.upgrade(req)) return;
      if (pathname === "/json/version" && options.version) {
        return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}${browserPath}` });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      message(ws, data) {
        const { id, method } = JSON.parse(String(data));
        methods.push(method);
        if (options.rejectCdp) {
          ws.send(JSON.stringify({ id, error: { code: -32000, message: "Connection refused by browser" } }));
          return;
        }
        const result = method === "Browser.getVersion"
          ? { product: "Chrome/157.0.0.0", protocolVersion: "1.3", userAgent: "Discovery test", revision: "test", jsVersion: "test" }
          : method === "Target.getBrowserContexts" ? { browserContextIds: [] } : {};
        ws.send(JSON.stringify({ id, result }));
        if (method === "Target.setDiscoverTargets") {
          ws.send(JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: {
            targetId: "browser", type: "browser", title: "", url: "", attached: false, canAccessOpener: false,
          } } }));
        }
      },
    },
  });
  cleanup.push(() => server.stop(true));
  return { server, port: server.port!, browserPath, ws: `ws://127.0.0.1:${server.port}${browserPath}`, requests, methods };
}

function activePort(name: string, contents: string): string {
  const root = path.join(dir, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "DevToolsActivePort"), contents);
  return root;
}

describe("default Chrome user-data directories", () => {
  test("macOS includes stable, beta, dev, canary and Chromium", () => {
    expect(defaultChromeUserDataDirs("darwin", "/fixture", {})).toEqual([
      "/fixture/Library/Application Support/Google/Chrome",
      "/fixture/Library/Application Support/Google/Chrome Beta",
      "/fixture/Library/Application Support/Google/Chrome Dev",
      "/fixture/Library/Application Support/Google/Chrome Canary",
      "/fixture/Library/Application Support/Chromium",
    ]);
  });
  test("Linux honors config roots and uses the unstable directory for Dev", () => {
    const expected = ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "google-chrome-canary", "chromium"];
    expect(defaultChromeUserDataDirs("linux", "/fixture", {})).toEqual(expected.map((p) => `/fixture/.config/${p}`));
    expect(defaultChromeUserDataDirs("linux", "/fixture", { XDG_CONFIG_HOME: "/xdg" })).toEqual(expected.map((p) => `/xdg/${p}`));
    expect(defaultChromeUserDataDirs("linux", "/fixture", { CHROME_CONFIG_HOME: "/chrome", XDG_CONFIG_HOME: "/xdg" }))
      .toEqual(expected.map((p) => `/chrome/${p}`));
    expect(defaultChromeUserDataDirs("linux", "/fixture", { CHROME_CONFIG_HOME: "relative", XDG_CONFIG_HOME: "relative" }))
      .toEqual(expected.map((p) => `/fixture/.config/${p}`));
  });
  test("Windows uses LOCALAPPDATA and the Canary SxS directory", () => {
    expect(defaultChromeUserDataDirs("win32", "C:\\Fixture", { LOCALAPPDATA: "D:\\Local" })).toEqual([
      "D:\\Local\\Google\\Chrome\\User Data", "D:\\Local\\Google\\Chrome Beta\\User Data",
      "D:\\Local\\Google\\Chrome Dev\\User Data", "D:\\Local\\Google\\Chrome SxS\\User Data",
      "D:\\Local\\Chromium\\User Data",
    ]);
    expect(defaultChromeUserDataDirs("win32", "C:\\Fixture", {})[0]).toBe("C:\\Fixture\\AppData\\Local\\Google\\Chrome\\User Data");
    expect(defaultChromeUserDataDirs("freebsd", "/fixture", {})).toEqual([]);
  });
});

describe("DevToolsActivePort discovery", () => {
  test("falls back to a remembered port before the fixed port range when no file is present", async () => {
    const remembered = endpoint({ version: true });
    const fallback = endpoint({ version: true });
    fs.writeFileSync(path.join(dir, "chrome-ports.json"), JSON.stringify({ test: { port: remembered.port } }));
    const { browser, resolved } = await connectCdp({ kind: "cdp", url: "auto" }, log, { userDataDirs: [dir], ports: [fallback.port] });
    cleanup.push(() => browser.disconnect());
    expect(resolved.wsEndpoint).toBe(remembered.ws);
    expect(await browser.version()).toBe("Chrome/157.0.0.0");
  });

  test("connects to the advertised websocket even when /json/version returns 404", async () => {
    const chrome = endpoint();
    const fallback = endpoint({ version: true });
    const root = activePort("chrome", `${chrome.port}\r\n${chrome.browserPath}\r\n`);
    expect((await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).status).toBe(404);
    chrome.requests.length = 0;
    const { browser, resolved } = await connectCdp({ kind: "cdp", url: "auto" }, log, { userDataDirs: [root], ports: [fallback.port] });
    cleanup.push(() => browser.disconnect());
    expect(browser.connected).toBe(true);
    expect(await browser.version()).toBe("Chrome/157.0.0.0");
    expect(resolved).toEqual({ wsEndpoint: chrome.ws, requested: "auto", discoveryFile: path.join(root, "DevToolsActivePort") });
    expect(chrome.requests).toEqual([chrome.browserPath]);
    expect(fallback.requests).toEqual([]);
  });

  test("an advertised live port refusing the websocket is an error, without trying another browser", async () => {
    const denied = endpoint({ rejectWebSocket: true });
    const other = endpoint({ version: true });
    const first = activePort("first", `${denied.port}\n${denied.browserPath}`);
    const second = activePort("second", `${other.port}\n${other.browserPath}`);
    await expect(connectCdp({ kind: "cdp", url: "auto" }, log, { userDataDirs: [first, second], ports: [other.port] }))
      .rejects.toThrow(/DevToolsActivePort.*did not accept[\s\S]*Not connecting to another browser/);
    expect(denied.requests).toEqual([denied.browserPath]);
    expect(other.requests).toEqual([]);
  });

  test("a CDP handshake error after websocket acceptance never falls back to another browser", async () => {
    const denied = endpoint({ rejectCdp: true });
    const other = endpoint({ version: true });
    const first = activePort("first", `${denied.port}\n${denied.browserPath}`);
    const second = activePort("second", `${other.port}\n${other.browserPath}`);
    await expect(connectCdp({ kind: "cdp", url: "auto" }, log, { userDataDirs: [first, second], ports: [other.port] }))
      .rejects.toThrow(/Connection refused by browser[\s\S]*Not connecting to another browser/);
    expect(denied.methods.length).toBeGreaterThan(0);
    expect(other.requests).toEqual([]);
  });

  test("a stale advertised port is skipped for the next channel", async () => {
    const stale = endpoint();
    await stale.server.stop(true);
    const live = endpoint();
    const roots = [activePort("stale", `${stale.port}\n${stale.browserPath}`), activePort("live", `${live.port}\n${live.browserPath}`)];
    expect((await resolveCdpEndpoint("auto", log, { userDataDirs: roots, ports: [] })).wsEndpoint).toBe(live.ws);
    expect(messages.some((message) => message.includes("ignoring stale"))).toBe(true);
  });

  test("missing, malformed and stale files retain HTTP port discovery", async () => {
    const fallback = endpoint({ version: true });
    const stale = endpoint(); await stale.server.stop(true);
    const roots = [path.join(dir, "missing")];
    for (const [i, contents] of [
      `0\n/devtools/browser/a`, `65536\n/devtools/browser/a`, `123x\n/devtools/browser/a`,
      `${fallback.port}\n/ws`, `${fallback.port}\n/devtools/browser/a?secret=x`,
      `${fallback.port}\n/devtools/browser/a\nextra`, `${stale.port}\n/devtools/browser/stale`,
    ].entries()) roots.push(activePort(`candidate-${i}`, contents));
    const resolved = await resolveCdpEndpoint("auto", log, { userDataDirs: roots, ports: [fallback.port] });
    expect(resolved).toEqual({ wsEndpoint: fallback.ws, requested: "auto" });
    expect(fallback.requests).toEqual(["/json/version"]);
  });

  test("explicit websocket and HTTP endpoints never consult auto-discovery", async () => {
    const explicit = endpoint({ version: true });
    const ignored = endpoint({ rejectWebSocket: true });
    const root = activePort("ignored", `${ignored.port}\n${ignored.browserPath}`);
    const lookup = { userDataDirs: [root], ports: [ignored.port] };
    const { browser } = await connectCdp({ kind: "cdp", url: explicit.ws }, log, lookup);
    cleanup.push(() => browser.disconnect());
    for (const url of [`http://127.0.0.1:${explicit.port}`, String(explicit.port), `127.0.0.1:${explicit.port}`]) {
      expect((await resolveCdpEndpoint(url, log, lookup)).wsEndpoint).toBe(explicit.ws);
    }
    expect(ignored.requests).toEqual([]);
  });

  test("nothing found explains both discovery methods and Chrome's built-in setting", async () => {
    await expect(resolveCdpEndpoint("auto", log, { userDataDirs: [dir], ports: [] }))
      .rejects.toThrow(/default user-data directories[\s\S]*chrome:\/\/inspect\/#remote-debugging/);
  });
});
