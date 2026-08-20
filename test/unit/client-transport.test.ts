/**
 * Unit tests for the client transport (socket backpressure), profile-lock
 * safety predicate, Chrome discovery, endpoint redaction and flag plumbing.
 */
import { test, expect, describe, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { tryConnect } from "../../src/cli/client.ts";
import { classifyLockHolder, keyFor, chromePortPids } from "../../src/daemon/browsers.ts";
import { redactEndpoint } from "../../src/daemon/sources/cdp.ts";
import { pickChromeForUser } from "../../src/cli/commands/chrome.ts";
import { installedCandidates } from "../../src/shared/chrome.ts";
import { paths, ensureHome } from "../../src/shared/paths.ts";
import { parseArgs } from "../../src/cli/args.ts";

const tmpDirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("client transport: Bun.connect backpressure", () => {
  test("a 2 MB payload arrives intact when the server reads slowly", async () => {
    const dir = tmpDir("doobie-conn-");
    const sockPath = path.join(dir, "s.sock");
    const received: Buffer[] = [];
    let total = 0;
    const expectedBytes = 2 * 1024 * 1024 + 1;
    const done = new Promise<void>((resolve) => {
      const server = net.createServer((sock) => {
        // Do not read for a while so the kernel send buffer (~200 KB) fills up.
        sock.pause();
        setTimeout(() => sock.resume(), 400);
        sock.on("data", (c: Buffer) => {
          received.push(c);
          total += c.length;
          if (total >= expectedBytes) {
            sock.end();
            server.close();
            resolve();
          }
        });
      });
      server.listen(sockPath);
    });
    const conn = await tryConnect(sockPath, 2000);
    expect(conn).not.toBeNull();
    const payload = "y".repeat(expectedBytes - 1) + "\n";
    conn!.write(payload);
    conn!.end();
    await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("payload did not arrive in 10 s")), 10_000))]);
    const all = Buffer.concat(received).toString("utf8");
    expect(all.length).toBe(expectedBytes);
    expect(all.endsWith("y\n")).toBe(true);
    expect(all.indexOf("\n")).toBe(expectedBytes - 1);
  }, 15_000);

  test("many small writes keep their order under backpressure", async () => {
    const dir = tmpDir("doobie-conn-");
    const sockPath = path.join(dir, "s.sock");
    let buf = "";
    const n = 2000;
    const chunk = "z".repeat(1000);
    const done = new Promise<void>((resolve) => {
      const server = net.createServer((sock) => {
        sock.pause();
        setTimeout(() => sock.resume(), 200);
        sock.setEncoding("utf8");
        sock.on("data", (c: string) => {
          buf += c;
          if (buf.split("\n").length - 1 >= n) {
            sock.end();
            server.close();
            resolve();
          }
        });
      });
      server.listen(sockPath);
    });
    const conn = await tryConnect(sockPath, 2000);
    for (let i = 0; i < n; i++) conn!.write(`${i}:${chunk}\n`);
    await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 10_000))]);
    const lines = buf.split("\n").filter(Boolean);
    expect(lines.length).toBe(n);
    for (let i = 0; i < n; i++) expect(lines[i]!.startsWith(`${i}:`)).toBe(true);
  }, 15_000);
});

describe("profile lock safety predicate (classifyLockHolder)", () => {
  const dir = "/home/u/.doobie/browsers/work/profile";
  const alive = new Set([100, 200, 300, 4242]);
  const probeBase = {
    alive: (pid: number) => alive.has(pid),
    cmdline: (pid: number) => (pid === 100 || pid === 200 || pid === 300 ? `chrome --user-data-dir=${dir}` : "bash"),
    selfPid: 4242,
  };

  test("no lock -> none; dead holder -> stale", () => {
    expect(classifyLockHolder(dir, new Set(), { ...probeBase, lockPid: () => null })).toEqual({ kind: "none" });
    expect(classifyLockHolder(dir, new Set(), { ...probeBase, lockPid: () => 999 })).toEqual({ kind: "stale", pid: 999 });
  });

  test("a pid that belongs to a live BrowserManager entry or chrome-ports.json is ours, never an orphan", () => {
    const r = classifyLockHolder(dir, new Set([100]), { ...probeBase, lockPid: () => 100, ppid: () => 1 });
    expect(r).toEqual({ kind: "ours", pid: 100 });
  });

  test("reparented to init (daemon died) -> orphan; parent vanished -> orphan", () => {
    expect(classifyLockHolder(dir, new Set(), { ...probeBase, lockPid: () => 100, ppid: () => 1 })).toEqual({ kind: "orphan", pid: 100 });
    expect(classifyLockHolder(dir, new Set(), { ...probeBase, lockPid: () => 100, ppid: () => 555 })).toEqual({ kind: "orphan", pid: 100 });
    expect(classifyLockHolder(dir, new Set(), { ...probeBase, lockPid: () => 100, ppid: () => null })).toEqual({ kind: "orphan", pid: 100 });
  });

  test("a live parent that is not us (another daemon, a manual launch) -> foreign, not killable", () => {
    expect(classifyLockHolder(dir, new Set(), { ...probeBase, lockPid: () => 200, ppid: () => 300 })).toEqual({ kind: "foreign", pid: 200, ppid: 300 });
  });

  test("our own child that is not a live entry -> child (wait first)", () => {
    expect(classifyLockHolder(dir, new Set(), { ...probeBase, lockPid: () => 200, ppid: () => 4242 })).toEqual({ kind: "child", pid: 200 });
  });

  test("pid reuse: live process that does not mention the profile -> unrelated", () => {
    expect(classifyLockHolder(dir, new Set(), { ...probeBase, lockPid: () => 4242, ppid: () => 1 })).toEqual({ kind: "unrelated", pid: 4242 });
  });

  test("chromePortPids reads pids recorded by `doobie chrome`", () => {
    const home = tmpDir("doobie-home-");
    const prev = process.env.DOOBIE_HOME;
    process.env.DOOBIE_HOME = home;
    try {
      expect(chromePortPids()).toEqual([]);
      fs.writeFileSync(paths.chromePorts(), JSON.stringify({ a: { port: 9222, pid: 777 }, b: { port: 9223 } }));
      expect(chromePortPids()).toEqual([777]);
    } finally {
      if (prev === undefined) delete process.env.DOOBIE_HOME;
      else process.env.DOOBIE_HOME = prev;
    }
  });
});

describe("profile dirs", () => {
  test("headed and headless instances of one name use different user-data-dirs; doobie chrome has its own root", () => {
    const home = tmpDir("doobie-home-");
    const prev = process.env.DOOBIE_HOME;
    process.env.DOOBIE_HOME = home;
    try {
      const headed = paths.profile("work");
      const headless = paths.profile("work", true);
      const chrome = paths.chromeProfile("work");
      expect(headed).toBe(path.join(home, "browsers", "work", "profile"));
      expect(headless).toBe(path.join(home, "browsers", "work", "profile-headless"));
      expect(chrome).toBe(path.join(home, "chrome-profiles", "work"));
      expect(new Set([headed, headless, chrome]).size).toBe(3);
      expect(paths.downloads()).toBe(path.join(home, "tmp", "downloads"));
    } finally {
      if (prev === undefined) delete process.env.DOOBIE_HOME;
      else process.env.DOOBIE_HOME = prev;
    }
  });

  test("keyFor: headless and --ignore-https-errors get their own instances", () => {
    expect(keyFor({ kind: "launch", name: "a", headless: false })).toBe("a");
    expect(keyFor({ kind: "launch", name: "a", headless: true })).toBe("a:headless");
    expect(keyFor({ kind: "launch", name: "a", headless: true, ignoreHTTPSErrors: true })).toBe("a:headless:insecure");
    expect(keyFor({ kind: "cdp", url: "auto", ignoreHTTPSErrors: true })).toBe("cdp:auto:insecure");
  });
});

describe("Chrome for Testing discovery (installedCandidates)", () => {
  function fakeBinary(p: string): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "#!/bin/sh\n", { mode: 0o755 });
  }

  test("finds the linux and the (deep) macOS layouts under a temp DOOBIE_HOME", () => {
    const home = tmpDir("doobie-home-");
    const prev = process.env.DOOBIE_HOME;
    process.env.DOOBIE_HOME = home;
    try {
      const root = paths.chromeDir();
      const linux = path.join(root, "chrome", "linux-139.0.7258.66", "chrome-linux64", "chrome");
      const mac = path.join(
        root,
        "chrome",
        "mac_arm-139.0.7258.66",
        "chrome-mac-arm64",
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing",
      );
      fakeBinary(linux);
      fakeBinary(mac);
      // Decoys: a helper binary named chrome deeper than anything real is still fine, non-executables are not.
      fs.writeFileSync(path.join(root, "chrome", "linux-139.0.7258.66", "chrome-linux64", "chrome_crashpad_handler"), "", { mode: 0o755 });
      const found = installedCandidates();
      expect(found).toContain(linux);
      expect(found).toContain(mac);
      expect(found.length).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.DOOBIE_HOME;
      else process.env.DOOBIE_HOME = prev;
    }
  });
});

describe("doobie chrome picks the user's real browser", () => {
  test("system beats env/config beats installed/playwright", () => {
    expect(
      pickChromeForUser([
        { path: "/cft/chrome", source: "installed" },
        { path: "/opt/google/chrome/chrome", source: "system" },
        { path: "/env/chrome", source: "env" },
      ])?.path,
    ).toBe("/opt/google/chrome/chrome");
    expect(
      pickChromeForUser([
        { path: "/cft/chrome", source: "installed" },
        { path: "/env/chrome", source: "env" },
      ])?.path,
    ).toBe("/env/chrome");
    expect(pickChromeForUser([{ path: "/pw/chromium", source: "playwright" }, { path: "/cft/chrome", source: "installed" }])?.source).toBe("installed");
    expect(pickChromeForUser([])).toBeNull();
  });
});

describe("CDP endpoint redaction", () => {
  test("drops query strings and userinfo, keeps host/port/path", () => {
    expect(redactEndpoint("ws://127.0.0.1:9222/devtools/browser/abc-123")).toBe("ws://127.0.0.1:9222/devtools/browser/abc-123");
    expect(redactEndpoint("wss://chrome.browserless.io/?token=SECRET")).toBe("wss://chrome.browserless.io/");
    expect(redactEndpoint("wss://user:pw@host:443/path?x=1#f")).toBe("wss://host/path");
    expect(redactEndpoint("not a url?token=x")).toBe("not a url");
  });
});

describe("--ignore-https-errors flag", () => {
  test("is parsed and absent by default", () => {
    expect(parseArgs(["-e", "1"]).flags.ignoreHttpsErrors).toBeUndefined();
    expect(parseArgs(["--ignore-https-errors", "-e", "1"]).flags.ignoreHttpsErrors).toBe(true);
  });
});

describe("read-only DOOBIE_HOME", () => {
  test("ensureHome fails fast with a clear message", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    const base = tmpDir("doobie-ro-");
    const home = path.join(base, "home");
    fs.mkdirSync(home, { mode: 0o500 });
    const prev = process.env.DOOBIE_HOME;
    process.env.DOOBIE_HOME = home;
    try {
      expect(() => ensureHome()).toThrow(/cannot write to DOOBIE_HOME .*EACCES/);
    } finally {
      fs.chmodSync(home, 0o700);
      if (prev === undefined) delete process.env.DOOBIE_HOME;
      else process.env.DOOBIE_HOME = prev;
    }
  });
});
