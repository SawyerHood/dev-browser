/**
 * CDP source: attach to a running Chrome.
 *
 *   --connect                -> "auto": ports remembered by `doobie chrome`, then 9222-9229
 *   --connect http://h:p     -> GET /json/version, use webSocketDebuggerUrl
 *   --connect ws://...       -> connect directly
 */
import * as fs from "node:fs";
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
 * Endpoint URL safe for logs, `doobie status` and registry keys: remote CDP
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
    "Start Chrome with remote debugging, for example `doobie chrome` (recommended), or\n" +
    "  macOS:  open -a 'Google Chrome' --args --remote-debugging-port=9222 --user-data-dir=$HOME/.doobie/browsers/manual\n" +
    "  Linux:  google-chrome --remote-debugging-port=9222 --user-data-dir=$HOME/.doobie/browsers/manual\n" +
    "Chrome 136+ ignores --remote-debugging-port on the default profile; always pass --user-data-dir."
  );
}

/** Resolve a requested endpoint to a browser websocket URL. */
export async function resolveCdpEndpoint(url: string, log: FileLogger): Promise<ResolvedCdp> {
  if (url === "auto" || url === "") {
    const ports = [...new Set([...rememberedPorts(), ...AUTO_PORTS])];
    const probes = ports.map(async (port) => {
      const v = await fetchVersion(`http://127.0.0.1:${port}`, PROBE_TIMEOUT_MS);
      return v?.webSocketDebuggerUrl ? { port, ws: v.webSocketDebuggerUrl } : null;
    });
    const results = await Promise.all(probes);
    const hit = results.find((r) => r !== null);
    if (!hit) {
      throw new CdpConnectError(
        `No Chrome with remote debugging found on ports ${ports.join(", ")}.\n` + chromeLaunchHint(),
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

export async function connectCdp(spec: CdpSource, log: FileLogger): Promise<{ browser: Browser; resolved: ResolvedCdp }> {
  const resolved = await resolveCdpEndpoint(spec.url, log);
  const t0 = Date.now();
  const browser = await puppeteer.connect({
    browserWSEndpoint: resolved.wsEndpoint,
    defaultViewport: null,
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
    acceptInsecureCerts: spec.ignoreHTTPSErrors === true,
  });
  log.info(`connected to ${redactEndpoint(resolved.wsEndpoint)} in ${Date.now() - t0}ms`);
  return { browser, resolved };
}
