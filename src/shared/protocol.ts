/**
 * Wire protocol between the dev-browser client and the daemon.
 *
 * Transport: one Unix socket connection per request. Both directions send
 * newline-delimited JSON (NDJSON). The client sends exactly one `hello`
 * line followed by exactly one request line. The daemon answers with a
 * `hello` line, then zero or more stream frames, then exactly one terminal
 * `done` frame (or closes the socket on a fatal daemon error).
 *
 * The same frames are what `dev-browser --json` prints, so an MCP server or bb
 * can reuse them without a new contract.
 */

export const PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Browser sources                                                     */
/* ------------------------------------------------------------------ */

/** Launch a Chrome with a persistent named profile under ~/.dev-browser/v1/browsers/<name>. */
export interface LaunchSource {
  kind: "launch";
  /** Profile name. Sanitized to [A-Za-z0-9._-]. */
  name: string;
  headless: boolean;
  /** Accept self-signed / invalid TLS certificates (`--ignore-https-errors`). Gets its own instance (key suffix ":insecure"). */
  ignoreHTTPSErrors?: boolean;
}

/** Attach to a running Chrome over CDP. `auto` discovers a local endpoint. */
export interface CdpSource {
  kind: "cdp";
  /** "auto" | http(s)://host:port | ws(s)://... */
  url: string;
  /** Accept self-signed / invalid TLS certificates (`--ignore-https-errors`). */
  ignoreHTTPSErrors?: boolean;
}

/** Attach over a local socket that speaks raw CDP JSON lines (bb hook). */
export interface SocketSource {
  kind: "socket";
  /** unix:/abs/path or pipe:name */
  path: string;
}

export type BrowserSourceSpec = LaunchSource | CdpSource | SocketSource;

/* ------------------------------------------------------------------ */
/* Client -> daemon                                                    */
/* ------------------------------------------------------------------ */

export interface HelloFromClient {
  type: "hello";
  version: string;
  protocol: number;
}

export interface RunRequest {
  type: "run";
  id: string;
  script: string;
  /** Display name for stack traces, e.g. "script.js" or "<stdin>". */
  scriptName: string;
  source: BrowserSourceSpec;
  /** Absolute deadline for the whole request in ms. */
  timeoutMs: number;
  /** Browser idle timeout in ms; 0 disables. Applies to launched browsers only. */
  idleTimeoutMs: number;
  /** Suppress page console/error collection. */
  quietPage: boolean;
  /** Working directory of the caller (for relative paths in messages only). */
  cwd: string;
}

export interface PagesRequest {
  type: "pages";
  source?: BrowserSourceSpec;
}

export interface BrowsersRequest {
  type: "browsers";
}

export interface StatusRequest {
  type: "status";
}

export interface StopRequest {
  type: "stop";
  /** Browser key or profile name. Omit to stop everything and exit the daemon. */
  browser?: string;
}

/** Ask the daemon to exit now (used on version mismatch). */
export interface ShutdownRequest {
  type: "shutdown";
}

export type Request =
  | RunRequest
  | PagesRequest
  | BrowsersRequest
  | StatusRequest
  | StopRequest
  | ShutdownRequest;

/* ------------------------------------------------------------------ */
/* Daemon -> client                                                    */
/* ------------------------------------------------------------------ */

export interface HelloFromDaemon {
  type: "hello";
  version: string;
  protocol: number;
  pid: number;
}

export interface StdoutFrame {
  type: "stdout";
  data: string;
}

export interface StderrFrame {
  type: "stderr";
  data: string;
}

/** Emitted by page.shot(); the client prints the path in text mode. */
export interface ImageFrame {
  type: "image";
  path: string;
  width: number;
  height: number;
}

/** The script's return value, already formatted for display. Absent when undefined. */
export interface ResultFrame {
  type: "result";
  value: string;
  /** Structured value when the result is JSON-serializable (strings, numbers, objects, arrays). */
  data?: unknown;
}

export interface PageInfo {
  /** CDP target id. */
  id: string;
  name: string | null;
  url: string;
  title: string;
}

export type ErrorKind = "script" | "timeout" | "daemon" | "version" | "usage";

export interface ErrorFrame {
  type: "error";
  kind: ErrorKind;
  name: string;
  message: string;
  /** Cleaned stack, script frames only, newline separated. */
  stack?: string;
  /** Pages the script touched, for recovery context. */
  pages?: PageInfo[];
  /** Set when kind === "version". */
  daemonVersion?: string;
}

/** Payload for pages/browsers/status requests. */
export interface DataFrame {
  type: "data";
  payload: unknown;
}

export interface DoneFrame {
  type: "done";
  exitCode: number;
  durationMs: number;
}

export type Frame =
  | HelloFromDaemon
  | StdoutFrame
  | StderrFrame
  | ImageFrame
  | ResultFrame
  | ErrorFrame
  | DataFrame
  | DoneFrame;

/* ------------------------------------------------------------------ */
/* Data payload shapes                                                 */
/* ------------------------------------------------------------------ */

export interface BrowserInfo {
  /** Registry key, e.g. "default", "work:headless", "cdp:ws://127.0.0.1:9222/...". */
  key: string;
  kind: BrowserSourceSpec["kind"];
  /** Profile name for launched browsers. */
  name?: string;
  headless?: boolean;
  connected: boolean;
  pages: number;
  /** ms since last activity. */
  idleMs: number;
  idleTimeoutMs: number;
  wsEndpoint?: string;
}

export interface StatusPayload {
  pid: number;
  version: string;
  uptimeMs: number;
  socketPath: string;
  logPath: string;
  activeRuns: number;
  browsers: BrowserInfo[];
  /** Last lines of the daemon log. */
  logTail: string[];
}

export interface PagesPayload {
  browser: string;
  pages: PageInfo[];
}

/* ------------------------------------------------------------------ */
/* Exit codes                                                          */
/* ------------------------------------------------------------------ */

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_TIMEOUT = 124;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function encodeFrame(frame: object): string {
  return JSON.stringify(frame) + "\n";
}

/**
 * Incremental NDJSON decoder. Feed chunks, get parsed objects.
 * Caps a single line at `maxLine` chars to bound memory.
 */
export class LineDecoder<T = unknown> {
  private buf = "";
  constructor(private readonly maxLine = 50 * 1024 * 1024) {}

  push(chunk: string | Uint8Array): T[] {
    this.buf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    if (this.buf.length > this.maxLine) {
      throw new Error(`protocol line exceeds ${this.maxLine} chars`);
    }
    const out: T[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.trim().length === 0) continue;
      out.push(JSON.parse(line) as T);
    }
    return out;
  }
}
