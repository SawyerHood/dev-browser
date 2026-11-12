/**
 * CDP source: attach to a running Chrome.
 *
 *   --connect                -> "auto": Chrome's DevToolsActivePort, then remembered ports and 9222-9229
 *   --connect http://h:p     -> GET /json/version, use webSocketDebuggerUrl
 *   --connect ws://...       -> connect directly
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import type { CdpSource } from "../../shared/protocol.ts";
import { paths } from "../../shared/paths.ts";
import type { FileLogger } from "../../shared/log.ts";
import { PROTOCOL_TIMEOUT_MS } from "./launch.ts";

export const AUTO_PORTS = [9222, 9223, 9224, 9225, 9226, 9227, 9228, 9229];
const PROBE_TIMEOUT_MS = 400;

export class CdpConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpConnectError";
  }
}

/**
 * Endpoint URL safe for logs, `dev-browser status` and registry keys: remote CDP
 * providers put API tokens in the query string or userinfo; keep only
 * scheme://host:port/path.
 */
export function redactEndpoint(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url.replace(/^([a-z]+:\/\/)[^@/]*@/i, "$1").replace(/[?#].*$/, "");
  }
}

export interface ResolvedCdp {
  wsEndpoint: string;
  /** What the user asked for; "auto" or the original URL. */
  requested: string;
  /** Present when auto-discovery selected Chrome's advertised browser endpoint. */
  discoveryFile?: string;
}

/** Lookup inputs are injectable so tests never probe the user's Chrome. */
export interface CdpDiscoveryOptions {
  userDataDirs?: readonly string[];
  /** Override the fixed probe range; remembered ports still come first. */
  ports?: readonly number[];
}

/** Chromium's documented default user-data roots, in channel preference order. */
export function defaultChromeUserDataDirs(
  platform: NodeJS.Platform = process.platform,
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === "darwin") {
    const base = path.posix.join(homeDir, "Library/Application Support");
    return ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Dev", "Google/Chrome Canary", "Chromium"]
      .map((dir) => path.posix.join(base, dir));
  }
  if (platform === "linux") {
    const base = [env.CHROME_CONFIG_HOME, env.XDG_CONFIG_HOME].find((dir) => dir && path.posix.isAbsolute(dir))
      ?? path.posix.join(homeDir, ".config");
    return ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "google-chrome-canary", "chromium"]
      .map((dir) => path.posix.join(base, dir));
  }
  if (platform === "win32") {
    const base = env.LOCALAPPDATA && path.win32.isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA : path.win32.join(homeDir, "AppData/Local");
    return ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Dev", "Google/Chrome SxS", "Chromium"]
      .map((dir) => path.win32.join(base, dir, "User Data"));
  }
  return [];
}

/** Only a refused TCP connection establishes a stale advertised endpoint. */
function portListening(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (err: Error | null, listening = false) => {
      socket.destroy();
      if (err) reject(err);
      else resolve(listening);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(new Error(`Timed out checking port ${port}`)));
    socket.once("connect", () => finish(null, true));
    socket.once("error", (err: NodeJS.ErrnoException) => finish(err.code === "ECONNREFUSED" ? null : err));
  });
}

async function advertisedEndpoint(dirs: readonly string[], log: FileLogger): Promise<ResolvedCdp | null> {
  for (const dir of dirs) {
    const file = path.join(dir, "DevToolsActivePort");
    let contents: string;
    try {
      contents = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const [portText, wsPath, extra] = contents.trim().split(/\r?\n/);
    const port = Number(portText);
    if (!/^\d+$/.test(portText ?? "") || port < 1 || port > 65535 || extra !== undefined ||
        !/^\/devtools\/browser\/[^\s/?#\\]+$/.test(wsPath ?? "")) {
      log.warn(`ignoring malformed ${file}`);
      continue;
    }
    let listening: boolean;
    try {
      listening = await portListening(port);
    } catch (err) {
      throw new CdpConnectError(`Could not check Chrome advertised by ${file}: ${(err as Error).message}. Not probing another browser.`);
    }
    if (!listening) {
      log.info(`ignoring stale ${file}: nothing listens on port ${port}`);
      continue;
    }
    log.info(`cdp auto-discovered Chrome via ${file}`);
    return { wsEndpoint: `ws://127.0.0.1:${port}${wsPath}`, requested: "auto", discoveryFile: file };
  }
  return null;
}

async function fetchVersion(httpBase: string, timeoutMs: number): Promise<{ webSocketDebuggerUrl?: string } | null> {
  const base = httpBase.replace(/\/+$/, "");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/json/version`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as { webSocketDebuggerUrl?: string };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function rememberedPorts(): number[] {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.chromePorts(), "utf8")) as Record<string, { port: number }>;
    return Object.values(raw)
      .map((v) => v.port)
      .filter((p) => Number.isInteger(p));
  } catch {
    return [];
  }
}

export function chromeLaunchHint(): string {
  return (
    "To attach to your existing Chrome session, enable remote debugging at chrome://inspect/#remote-debugging, then retry --connect.\n" +
    "Start Chrome with remote debugging, for example `dev-browser chrome` (recommended), or\n" +
    "  macOS:  open -a 'Google Chrome' --args --remote-debugging-port=9222 --user-data-dir=$HOME/.dev-browser/v1/browsers/manual\n" +
    "  Linux:  google-chrome --remote-debugging-port=9222 --user-data-dir=$HOME/.dev-browser/v1/browsers/manual\n" +
    "Chrome 136+ ignores --remote-debugging-port on the default profile; always pass --user-data-dir."
  );
}

/** Resolve a requested endpoint to a browser websocket URL. */
export async function resolveCdpEndpoint(url: string, log: FileLogger, discovery: CdpDiscoveryOptions = {}): Promise<ResolvedCdp> {
  if (url === "auto" || url === "") {
    // chrome://inspect endpoints may return 404 for /json/version. Use the
    // browser websocket Chrome wrote to disk before probing HTTP endpoints.
    const advertised = await advertisedEndpoint(discovery.userDataDirs ?? defaultChromeUserDataDirs(), log);
    if (advertised) return advertised;
    const ports = [...new Set([...rememberedPorts(), ...(discovery.ports ?? AUTO_PORTS)])];
    const probes = ports.map(async (port) => {
      const v = await fetchVersion(`http://127.0.0.1:${port}`, PROBE_TIMEOUT_MS);
      return v?.webSocketDebuggerUrl ? { port, ws: v.webSocketDebuggerUrl } : null;
    });
    const results = await Promise.all(probes);
    const hit = results.find((r) => r !== null);
    if (!hit) {
      throw new CdpConnectError(
        `No Chrome with remote debugging found in default user-data directories or on ports ${ports.join(", ")}.\n` + chromeLaunchHint(),
      );
    }
    log.info(`cdp auto-discovered Chrome on port ${hit.port}`);
    return { wsEndpoint: hit.ws, requested: "auto" };
  }
  if (/^wss?:\/\//i.test(url)) return { wsEndpoint: url, requested: url };
  if (/^https?:\/\//i.test(url)) {
    const v = await fetchVersion(url, 3000);
    if (!v?.webSocketDebuggerUrl) {
      throw new CdpConnectError(`Could not read ${url.replace(/\/+$/, "")}/json/version.\n` + chromeLaunchHint());
    }
    return { wsEndpoint: v.webSocketDebuggerUrl, requested: url };
  }
  if (/^\d+$/.test(url)) return resolveCdpEndpoint(`http://127.0.0.1:${url}`, log);
  if (/^[\w.-]+:\d+$/.test(url)) return resolveCdpEndpoint(`http://${url}`, log);
  throw new CdpConnectError(`Unrecognized --connect value "${url}". Use auto, http://host:port, or ws://...`);
}

export async function connectCdp(spec: CdpSource, log: FileLogger, discovery: CdpDiscoveryOptions = {}): Promise<{ browser: Browser; resolved: ResolvedCdp }> {
  const resolved = await resolveCdpEndpoint(spec.url, log, discovery);
  const t0 = Date.now();
  let browser: Browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: resolved.wsEndpoint,
      defaultViewport: null,
      protocolTimeout: PROTOCOL_TIMEOUT_MS,
      acceptInsecureCerts: spec.ignoreHTTPSErrors === true,
    });
  } catch (err) {
    if (!resolved.discoveryFile) throw err;
    throw new CdpConnectError(
      `Chrome advertised by ${resolved.discoveryFile} did not accept the DevTools connection: ${(err as Error).message}\n` +
      "If Chrome's remote debugging request was denied or timed out, retry when ready to allow it. Not connecting to another browser.",
    );
  }
  log.info(`connected to ${redactEndpoint(resolved.wsEndpoint)} in ${Date.now() - t0}ms`);
  return { browser, resolved };
}
