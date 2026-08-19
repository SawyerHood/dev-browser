/**
 * Execute one script request inside a fresh vm context.
 *
 * One absolute deadline covers browser connect + script + teardown. Output
 * after the terminal frame is dropped. Concurrent runs are allowed; only
 * browser connect is serialized (in BrowserManager).
 */
import * as vm from "node:vm";
import * as fs from "node:fs";
import * as util from "node:util";
import type { Page, ConsoleMessage } from "puppeteer-core";
import type { ErrorFrame, Frame, PageInfo, RunRequest } from "../shared/protocol.ts";
import { EXIT_ERROR, EXIT_OK, EXIT_TIMEOUT } from "../shared/protocol.ts";
import { DEFAULTS } from "../shared/config.ts";
import { ensureHome, jailPath } from "../shared/paths.ts";
import type { FileLogger } from "../shared/log.ts";
import type { BrowserManager, BrowserEntry } from "./browsers.ts";
import { transformScript, ScriptSyntaxError } from "./transform.ts";
import { formatScriptError } from "./errors.ts";
import { ChromeNotFoundError } from "../shared/chrome.ts";
import { CdpConnectError } from "./sources/cdp.ts";
import type { ShotResult } from "../page/shot.ts";
import { withRun } from "./run-context.ts";

export interface RunContext {
  manager: BrowserManager;
  log: FileLogger;
  emit: (frame: Frame) => void;
  /** Fires when the client goes away. */
  signal: AbortSignal;
}

export interface RunOutcome {
  exitCode: number;
}

class DeadlineError extends Error {
  constructor(readonly seconds: number) {
    super(`Timed out after ${seconds}s (deadline)`);
    this.name = "TimeoutError";
  }
}

const INSPECT: util.InspectOptions = { depth: 6, colors: false, maxArrayLength: 200, maxStringLength: 20_000, breakLength: 120 };

function isJSHandle(v: unknown): v is { asElement(): unknown } {
  return !!v && typeof v === "object" && typeof (v as { asElement?: unknown }).asElement === "function";
}
function isPage(v: unknown): v is Page {
  return !!v && typeof v === "object" && typeof (v as { mainFrame?: unknown }).mainFrame === "function" && typeof (v as { url?: unknown }).url === "function";
}

/** Replace Puppeteer objects with short tags so console/return output stays small. */
function tame(v: unknown, depth = 0): unknown {
  if (isJSHandle(v)) return v.asElement() ? "[ElementHandle]" : "[JSHandle]";
  if (isPage(v)) return `[Page ${(v as Page).url()}]`;
  if (v instanceof Uint8Array) return `<Buffer ${v.byteLength} bytes>`;
  if (depth > 6 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => tame(x, depth + 1));
  if (v instanceof Map || v instanceof Set || v instanceof Date || v instanceof RegExp || v instanceof Error) return v;
  const proto = Object.getPrototypeOf(v);
  if (proto !== null && proto !== Object.prototype && !isPlainLike(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = tame(val, depth + 1);
  return out;
}
function isPlainLike(v: object): boolean {
  // Objects created inside the vm realm have a different Object.prototype.
  const proto = Object.getPrototypeOf(v);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

export function formatConsoleArgs(args: unknown[]): string {
  const tamed = args.map((a) => tame(a));
  return util.formatWithOptions(INSPECT, ...(tamed as [unknown, ...unknown[]]));
}

export function formatResult(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  const t = tame(value);
  if (typeof t === "string") return t;
  try {
    const json = JSON.stringify(
      t,
      (_k, v: unknown) => {
        if (typeof v === "bigint") return v.toString() + "n";
        if (v instanceof Map) return Object.fromEntries(v);
        if (v instanceof Set) return [...v];
        if (v instanceof Error) return { name: v.name, message: v.message };
        return v;
      },
      2,
    );
    if (json !== undefined) return json;
  } catch {
    /* circular or exotic: fall through */
  }
  return util.inspect(t, INSPECT);
}

/* ------------------------------------------------------------------ */

export async function runScript(req: RunRequest, ctx: RunContext): Promise<RunOutcome> {
  const started = Date.now();
  const deadlineAt = started + Math.max(1000, req.timeoutMs);
  const remaining = () => Math.max(0, deadlineAt - Date.now());
  let finished = false;
  const emit = (f: Frame) => {
    if (!finished) ctx.emit(f);
  };
  const stdout = (s: string) => emit({ type: "stdout", data: s });
  const stderr = (s: string) => emit({ type: "stderr", data: s });

  // ---- transform first: syntax errors cost no browser time
  let transformed;
  try {
    transformed = transformScript(req.script);
  } catch (err) {
    const e = err as ScriptSyntaxError;
    emit({ type: "error", kind: "script", name: "SyntaxError", message: e.message });
    finished = true;
    return { exitCode: EXIT_ERROR };
  }

  const touched = new Map<Page, { name: string | null }>();
  const pageLines: string[] = [];
  const listeners: Array<() => void> = [];
  let entry: BrowserEntry | null = null;

  // ---- outcome: resolved exactly once, by the normal path, the client going
  // away, or the deadline timer. The timer is the authority for the deadline so
  // that a script whose promise chain never settles still ends the run.
  let resolveOutcome: (o: RunOutcome) => void = () => {};
  const outcome = new Promise<RunOutcome>((res) => {
    resolveOutcome = res;
  });
  let deadlineReject: (e: Error) => void = () => {};
  const deadlinePromise = new Promise<never>((_, rej) => {
    deadlineReject = rej;
  });
  deadlinePromise.catch(() => {});
  const cleanup = () => {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
    for (const off of listeners) off();
    if (pageLines.length > 0) stderr(pageLines.join("\n") + "\n");
    if (entry) {
      entry.activeRuns = Math.max(0, entry.activeRuns - 1);
      ctx.manager.touch(entry);
    }
  };
  const finish = (exitCode: number) => {
    if (finished) return;
    cleanup();
    finished = true;
    resolveOutcome({ exitCode });
  };
  const timer = setTimeout(() => {
    const err = new DeadlineError(Math.round(req.timeoutMs / 1000));
    deadlineReject(err);
    if (finished) return;
    void buildErrorFrame(err, req.scriptName, touched, 0, transformed.columnShifts).then((frame) => {
      if (finished) return;
      emit(frame);
      finish(EXIT_TIMEOUT);
    });
  }, remaining());
  const onAbort = () => deadlineReject(new AbortedError());
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  const track = (page: Page, name: string | null) => {
    if (touched.has(page)) return;
    touched.set(page, { name });
    if (req.quietPage) return;
    const label = () => `[page${name ? ":" + name : ""}]`;
    const onConsole = (msg: ConsoleMessage) => {
      const t = msg.type() as string;
      if (t !== "error" && t !== "warn" && t !== "warning") return;
      if (pageLines.length < DEFAULTS.pageConsoleMaxLines) {
        pageLines.push(`${label()} ${t === "error" ? "error" : "warn"}: ${msg.text()}`.slice(0, 500));
      }
    };
    const onPageError = (e: unknown) => {
      const err = e as Error | undefined;
      if (pageLines.length < DEFAULTS.pageConsoleMaxLines) {
        pageLines.push(`${label()} uncaught: ${err?.message ?? String(e)}`.slice(0, 500));
      }
    };
    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    listeners.push(() => {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
    });
  };

  void (async () => {
    // ---- browser
    entry = await Promise.race([
      ctx.manager.get(req.source, { timeoutMs: remaining(), idleTimeoutMs: req.idleTimeoutMs }),
      deadlinePromise,
    ]);
    entry.activeRuns++;
    ctx.manager.touch(entry);
    const pages = entry.pages;

    // ---- globals
    const browserApi = Object.freeze({
      getPage: async (name: string) => {
        const p = await pages.getPage(name);
        track(p, pages.nameOf(p) ?? (looksLikeId(name) ? null : name));
        return p;
      },
      newPage: async () => {
        const p = await pages.newPage();
        track(p, null);
        return p;
      },
      listPages: () => pages.listPages(),
      closePage: (name: string) => pages.closePage(name),
    });

    const consoleApi = {
      log: (...a: unknown[]) => stdout(formatConsoleArgs(a) + "\n"),
      info: (...a: unknown[]) => stdout(formatConsoleArgs(a) + "\n"),
      debug: (...a: unknown[]) => stdout(formatConsoleArgs(a) + "\n"),
      warn: (...a: unknown[]) => stderr(formatConsoleArgs(a) + "\n"),
      error: (...a: unknown[]) => stderr(formatConsoleArgs(a) + "\n"),
      table: (...a: unknown[]) => stdout(formatConsoleArgs(a) + "\n"),
      dir: (a: unknown) => stdout(util.inspect(tame(a), INSPECT) + "\n"),
    };

    ensureHome();
    const saveFile = (name: string, data: string | Uint8Array): string => {
      const file = jailPath(name);
      fs.writeFileSync(file, typeof data === "string" ? data : Buffer.from(data), { mode: 0o600 });
      return file;
    };
    const readFile = (name: string): string => fs.readFileSync(jailPath(name), "utf8");

    const sandbox: Record<string, unknown> = {
      browser: browserApi,
      console: consoleApi,
      saveFile,
      readFile,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      setImmediate,
      clearImmediate,
      queueMicrotask,
      structuredClone,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      Buffer,
      atob,
      btoa,
      fetch,
      AbortController,
      AbortSignal,
      Blob,
      FormData,
      Headers,
      Request,
      Response,
      crypto,
      performance,
    };
    const context = vm.createContext(sandbox, { name: "doobie-script" });

    // ---- run
    // No vm `timeout`: Bun's watchdog terminates async continuations in a way
    // that abandons promise chains and can wedge the event loop. A synchronous
    // infinite loop therefore blocks the daemon; the client's watchdog kills a
    // daemon that misses its deadline by 15 s and the next call restarts it.
    const fn = vm.runInContext(transformed.code, context, {
      filename: req.scriptName,
      lineOffset: transformed.lineOffset,
    }) as () => Promise<unknown>;
    const value = await Promise.race([withRun({ id: req.id, emit }, () => fn()), deadlinePromise]);
    const formatted = formatResult(value);
    if (formatted !== undefined) emit({ type: "result", value: formatted });
    return EXIT_OK;
  })().then(
    (code) => finish(code),
    async (err) => {
      if (err instanceof DeadlineError) return; // the timer owns the timeout frame
      const frame = await buildErrorFrame(err, req.scriptName, touched, remaining(), transformed.columnShifts);
      if (finished) return;
      emit(frame);
      finish(EXIT_ERROR);
    },
  );
  return outcome;
}

class AbortedError extends Error {
  constructor() {
    super("Client disconnected");
    this.name = "AbortedError";
  }
}

function looksLikeId(s: string): boolean {
  return /^[0-9A-F]{32}$/.test(s);
}

async function buildErrorFrame(
  err: unknown,
  scriptName: string,
  touched: Map<Page, { name: string | null }>,
  remainingMs: number,
  columnShifts: Record<number, number> = {},
): Promise<ErrorFrame> {
  const pages = await describePages(touched, Math.min(1500, Math.max(200, remainingMs)));
  if (err instanceof DeadlineError) {
    return { type: "error", kind: "timeout", name: "TimeoutError", message: err.message, pages };
  }
  if (err instanceof AbortedError) {
    return { type: "error", kind: "daemon", name: "AbortedError", message: err.message, pages };
  }
  if (err instanceof ChromeNotFoundError || err instanceof CdpConnectError) {
    return { type: "error", kind: "daemon", name: err.name, message: err.message };
  }
  const f = formatScriptError(err, scriptName, { columnShifts });
  return { type: "error", kind: "script", name: f.name, message: f.message, stack: f.stack, pages };
}

async function describePages(touched: Map<Page, { name: string | null }>, budgetMs: number): Promise<PageInfo[]> {
  const out: PageInfo[] = [];
  const jobs = [...touched.entries()].map(async ([page, meta]) => {
    if (page.isClosed()) return;
    const url = safeUrl(page);
    let title = "";
    try {
      title = await Promise.race([page.title(), new Promise<string>((r) => setTimeout(() => r(""), budgetMs))]);
    } catch {
      title = "";
    }
    let id = "";
    try {
      id = (page.target() as unknown as { _targetId?: string })._targetId ?? "";
    } catch {
      /* ignore */
    }
    out.push({ id, name: meta.name, url, title });
  });
  await Promise.all(jobs);
  return out;
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

export type { ShotResult };
