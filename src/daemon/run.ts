/**
 * Execute one script request inside a fresh vm context.
 *
 * One absolute deadline covers browser connect + script + teardown. Output
 * after the terminal frame is dropped. Concurrent runs are allowed; only
 * browser connect is serialized (in BrowserManager).
 *
 * Run guard: the script never sees raw Page objects. browser.getPage/newPage
 * hand out a Proxy bound to a per-run gate; once the run is over (normal end,
 * deadline or client disconnect) every further method call throws
 * RunAbortedError, so a zombie script dies at its next await instead of
 * mutating the page under the next script. The gate also records in-flight
 * calls (for the timeout message), listeners added with page.on/once (removed
 * at run end), request interception the script enabled (disabled at run end)
 * and timers created through the sandbox globals (cleared at run end).
 *
 * Pages that surface through Puppeteer's own graph (page.browser().pages(),
 * frame.page(), the 'popup' event) are mapped to the same per-run proxy as
 * browser.getPage returns for that Page, so identity comparisons work and the
 * gate covers them. ElementHandle/JSHandle/Frame objects are gated through
 * prototype patches that consult the active run (see page/extend.ts).
 */
import * as vm from "node:vm";
import * as fs from "node:fs";
import * as util from "node:util";
import type { Page, ConsoleMessage } from "puppeteer-core";
import { extendPage } from "../page/extend.ts";
import type { ErrorFrame, Frame, PageInfo, ResultFrame, RunRequest } from "../shared/protocol.ts";
import { EXIT_ERROR, EXIT_OK, EXIT_TIMEOUT } from "../shared/protocol.ts";
import { DEFAULTS } from "../shared/config.ts";
import { ensureHome, jailPath } from "../shared/paths.ts";
import type { FileLogger } from "../shared/log.ts";
import type { BrowserManager, BrowserEntry } from "./browsers.ts";
import { transformScript, ScriptSyntaxError, type TransformResult } from "./transform.ts";
import { formatScriptError } from "./errors.ts";
import { ChromeNotFoundError } from "../shared/chrome.ts";
import { CdpConnectError } from "./sources/cdp.ts";
import type { ShotResult } from "../page/shot.ts";
import { withRun, addPageLineHook } from "./run-context.ts";

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
  constructor(
    readonly seconds: number,
    inflight?: string,
  ) {
    super(`Timed out after ${seconds}s (deadline)${inflight ? ` while in ${inflight}` : ""}`);
    this.name = "TimeoutError";
  }
}

/** Thrown to a script that keeps running after its run ended (deadline, disconnect or normal end). */
export class RunAbortedError extends Error {
  constructor(reason: string) {
    super(`script ${reason}`);
    this.name = "RunAbortedError";
  }
}

const INSPECT: util.InspectOptions = { depth: 6, colors: false, maxArrayLength: 200, maxStringLength: 20_000, breakLength: 120 };

function isJSHandle(v: unknown): v is { asElement(): unknown } {
  return !!v && typeof v === "object" && typeof (v as { asElement?: unknown }).asElement === "function";
}
function isPage(v: unknown): v is Page {
  return !!v && typeof v === "object" && typeof (v as { mainFrame?: unknown }).mainFrame === "function" && typeof (v as { url?: unknown }).url === "function";
}
function isBrowser(v: unknown): boolean {
  return !!v && typeof v === "object" && typeof (v as { pages?: unknown }).pages === "function" && typeof (v as { wsEndpoint?: unknown }).wsEndpoint === "function";
}
function isFrame(v: unknown): boolean {
  return !!v && typeof v === "object" && typeof (v as { childFrames?: unknown }).childFrames === "function" && typeof (v as { page?: unknown }).page === "function";
}

/**
 * Replace Puppeteer objects with short tags so console/return output stays
 * small, and normalise vm-realm values (Error/Map/Set/typed arrays from the
 * script's context fail `instanceof` checks here) into printable shapes.
 */
export function tame(v: unknown, depth = 0): unknown {
  if (isJSHandle(v)) return v.asElement() ? "[ElementHandle]" : "[JSHandle]";
  if (isPage(v)) return `[Page ${safeUrl(v as Page)}]`;
  if (ArrayBuffer.isView(v)) return `<Buffer ${v.byteLength} bytes>`;
  if (depth > 6 || v === null || typeof v !== "object") return v;
  if (util.types.isNativeError(v)) {
    const e = v as Error;
    return `${e.name || "Error"}: ${e.message}`;
  }
  if (Array.isArray(v)) return v.map((x) => tame(x, depth + 1));
  if (util.types.isMap(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of v as Map<unknown, unknown>) out[typeof k === "string" ? k : String(k)] = tame(val, depth + 1);
    return out;
  }
  if (util.types.isSet(v)) return [...(v as Set<unknown>)].map((x) => tame(x, depth + 1));
  if (util.types.isDate(v) || util.types.isRegExp(v) || util.types.isPromise(v)) return v;
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

/** Display text plus, when the value is JSON-serializable, the structured value for --json consumers. */
export function renderResult(value: unknown): { text: string; data?: unknown } | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return { text: value, data: value };
  const t = tame(value);
  if (typeof t === "string") return { text: t, data: t };
  try {
    const json = JSON.stringify(
      t,
      (_k, v: unknown) => {
        if (typeof v === "bigint") return v.toString() + "n";
        if (util.types.isMap(v)) return Object.fromEntries(v as Map<string, unknown>);
        if (util.types.isSet(v)) return [...(v as Set<unknown>)];
        if (util.types.isNativeError(v)) return `${(v as Error).name}: ${(v as Error).message}`;
        return v;
      },
      2,
    );
    if (json !== undefined) return { text: json, data: JSON.parse(json) as unknown };
  } catch {
    /* circular or exotic: fall through */
  }
  return { text: util.inspect(t, INSPECT) };
}

export function formatResult(value: unknown): string | undefined {
  return renderResult(value)?.text;
}

/* ------------------------------------------------------------------ */
/* Run gate                                                            */
/* ------------------------------------------------------------------ */

type AnyFn = (...a: unknown[]) => unknown;

const LISTENER_ADD = new Set<PropertyKey>(["on", "once", "addListener", "prependListener", "prependOnceListener"]);
const LISTENER_REMOVE = new Set<PropertyKey>(["off", "removeListener"]);
const DEVICES = new Set<PropertyKey>(["mouse", "keyboard", "touchscreen"]);
/** Methods whose results can be Pages/Browsers/Frames and are mapped to gated proxies (see RunGate.mapValue). */
const MAPPED_RESULTS = new Set<PropertyKey>(["browser", "browserContext", "mainFrame", "frames", "pages", "newPage", "page", "childFrames", "parentFrame"]);

export class RunGate {
  finished = false;
  reason = "ended";
  /** In-flight wrapped calls, insertion ordered (the last one is the most recent). */
  private readonly inflight = new Map<object, string>();
  /** The most recent wrapped call that rejected: which object, which method, its first argument. */
  lastFailed: { target: object; name: string; arg: unknown } | undefined;
  /** Called for every Page that surfaces through the gate (getPage/newPage, browser().pages(), popups, frame.page()). */
  onPage: ((page: Page) => void) | null = null;
  private readonly listeners: Array<{ target: { off: AnyFn }; event: unknown; fn: unknown; orig: unknown }> = [];
  /** Pages on which the script enabled request interception (page -> enabled). */
  private readonly interception = new Map<object, boolean>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly intervals = new Set<ReturnType<typeof setInterval>>();
  private readonly immediates = new Set<ReturnType<typeof setImmediate>>();

  /**
   * What a call through a closed gate gets: a promise that rejects with
   * RunAbortedError after a short macrotask delay. Rejecting asynchronously
   * (rather than throwing) means a zombie that catches the error and retries
   * in a loop yields to the event loop instead of starving the daemon.
   */
  abortedCall(): Promise<never> {
    const reason = this.reason;
    // A script that swallows the error and retries forever is abandoned after a
    // few rounds: a promise that never settles lets the whole chain be GC'd.
    if (++this.abortedCalls > 50) return new Promise<never>(() => {});
    return new Promise((_, reject) => setTimeout(() => reject(new RunAbortedError(reason)), 25));
  }
  private abortedCalls = 0;

  /** Description of the most recent in-flight call, e.g. `page.click("ref/e4")`. */
  lastInflight(): string | undefined {
    let last: string | undefined;
    for (const d of this.inflight.values()) last = d;
    return last;
  }

  close(reason: string): void {
    if (this.finished) return;
    this.finished = true;
    this.reason = reason;
    for (const t of this.timers) clearTimeout(t);
    for (const t of this.intervals) clearInterval(t);
    for (const t of this.immediates) clearImmediate(t);
    this.timers.clear();
    this.intervals.clear();
    this.immediates.clear();
    for (const l of this.listeners) {
      try {
        l.target.off(l.event, l.fn);
      } catch {
        /* target gone */
      }
    }
    this.listeners.length = 0;
    // Interception is page state, not a listener: left on, every request on the
    // page would wait forever for a continue() nobody sends.
    for (const [page, on] of this.interception) {
      if (!on) continue;
      try {
        void (page as { setRequestInterception: (v: boolean) => Promise<void> }).setRequestInterception(false).catch(() => {});
      } catch {
        /* page gone */
      }
    }
    this.interception.clear();
  }

  /** Sandbox timer globals whose handles are cleared when the run ends. */
  timerGlobals(): Record<string, unknown> {
    const timers = this.timers;
    const intervals = this.intervals;
    const immediates = this.immediates;
    return {
      setTimeout: (fn: unknown, ms?: number, ...args: unknown[]) => {
        const h = setTimeout(() => {
          timers.delete(h);
          if (typeof fn === "function") (fn as AnyFn)(...args);
        }, ms);
        timers.add(h);
        return h;
      },
      clearTimeout: (h: ReturnType<typeof setTimeout>) => {
        timers.delete(h);
        clearTimeout(h);
      },
      setInterval: (fn: unknown, ms?: number, ...args: unknown[]) => {
        const h = setInterval(() => {
          if (typeof fn === "function") (fn as AnyFn)(...args);
        }, ms);
        intervals.add(h);
        return h;
      },
      clearInterval: (h: ReturnType<typeof setInterval>) => {
        intervals.delete(h);
        clearInterval(h);
      },
      setImmediate: (fn: unknown, ...args: unknown[]) => {
        const h = setImmediate(() => {
          immediates.delete(h);
          if (typeof fn === "function") (fn as AnyFn)(...args);
        });
        immediates.add(h);
        return h;
      },
      clearImmediate: (h: ReturnType<typeof setImmediate>) => {
        immediates.delete(h);
        clearImmediate(h);
      },
    };
  }

  private readonly guards = new WeakMap<object, object>();

  /** Wrap a Puppeteer object so every method call goes through the gate. Same target -> same proxy. */
  guard<T extends object>(target: T, label: string): T {
    const known = this.guards.get(target);
    if (known) return known as T;
    const proxy = this.makeGuard(target, label);
    this.guards.set(target, proxy);
    return proxy;
  }

  /**
   * Map a value coming out of a gated call: Pages, Browsers and Frames become
   * (identity-stable) gated proxies, arrays are mapped element-wise. Anything
   * else passes through untouched.
   */
  mapValue(v: unknown): unknown {
    if (!v || typeof v !== "object") return v;
    if (isPage(v)) {
      extendPage(v);
      this.onPage?.(v);
      return this.guard(v, "page");
    }
    if (isBrowser(v)) return this.guard(v, "browser");
    if (isFrame(v)) return this.guard(v, "frame");
    if (Array.isArray(v) && v.length > 0 && v.length <= 1000 && (isPage(v[0]) || isFrame(v[0]))) return v.map((x) => this.mapValue(x));
    return v;
  }

  private makeGuard<T extends object>(target: T, label: string): T {
    const cache = new Map<PropertyKey, { fn: unknown; wrapper: AnyFn }>();
    const subs = new Map<PropertyKey, { raw: unknown; proxy: object }>();
    const gate = this;
    let self: T;
    const proxy = new Proxy(target, {
      get(t, prop) {
        const v = Reflect.get(t, prop, t);
        if (typeof v !== "function") {
          if (DEVICES.has(prop) && v && typeof v === "object") {
            const s = subs.get(prop);
            if (s && s.raw === v) return s.proxy;
            const proxy = gate.guard(v as object, `${label}.${String(prop)}`);
            subs.set(prop, { raw: v, proxy });
            return proxy;
          }
          return v;
        }
        const c = cache.get(prop);
        if (c && c.fn === v) return c.wrapper;
        const wrapper = gate.wrap(t, prop, v as AnyFn, label, () => self);
        cache.set(prop, { fn: v, wrapper });
        return wrapper;
      },
      set(t, prop, value) {
        return Reflect.set(t, prop, value, t);
      },
    });
    self = proxy;
    return proxy;
  }

  private wrap(target: object, prop: PropertyKey, fn: AnyFn, label: string, self: () => object): AnyFn {
    const gate = this;
    const name = `${label}.${String(prop)}`;
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      if (gate.finished) return gate.abortedCall();
      if (LISTENER_ADD.has(prop)) {
        const [event, handler] = args;
        if (typeof handler === "function") {
          // Our own wrapper: event payloads that are Pages (popup) come back gated,
          // and off(event, handler) still works because the entry remembers `orig`.
          // Puppeteer's once() hides its wrapper, so once() is built on on() too.
          const once = prop === "once" || prop === "prependOnceListener";
          const t = target as { on: AnyFn; prependListener?: AnyFn; off: AnyFn };
          const entry = { target: t, event, fn: undefined as unknown, orig: handler };
          const w = (...a: unknown[]) => {
            if (once) {
              t.off(event, w);
              const i = gate.listeners.indexOf(entry);
              if (i >= 0) gate.listeners.splice(i, 1);
            }
            return (handler as AnyFn)(...a.map((x) => gate.mapValue(x)));
          };
          entry.fn = w;
          gate.listeners.push(entry);
          const method = prop === "once" || prop === "on" || prop === "addListener" ? t.on : (t.prependListener ?? t.on);
          method.call(t, event, w);
          return self();
        }
        gate.listeners.push({ target: target as { off: AnyFn }, event, fn: handler, orig: handler });
      } else if (LISTENER_REMOVE.has(prop)) {
        const [event, handler] = args;
        const i = gate.listeners.findIndex((l) => l.target === target && l.event === event && (l.fn === handler || l.orig === handler));
        if (i >= 0) {
          const entry = gate.listeners.splice(i, 1)[0]!;
          if (entry.fn !== handler) {
            fn.apply(target, [event, entry.fn]);
            return self();
          }
        }
      } else if (prop === "setRequestInterception") {
        gate.interception.set(target, args[0] === true);
      }
      const token = {};
      gate.inflight.set(token, describeCall(name, args));
      let result: unknown;
      try {
        result = fn.apply(target, args);
      } catch (err) {
        gate.inflight.delete(token);
        gate.lastFailed = { target, name, arg: args[0] };
        throw err;
      }
      if (result && typeof (result as Promise<unknown>).then === "function") {
        const mapped = MAPPED_RESULTS.has(prop);
        return (result as Promise<unknown>).then(
          (v) => {
            gate.inflight.delete(token);
            return mapped ? gate.mapValue(v) : v;
          },
          (err: unknown) => {
            gate.inflight.delete(token);
            gate.lastFailed = { target, name, arg: args[0] };
            throw err;
          },
        );
      }
      gate.inflight.delete(token);
      if (result === target) return self(); // on()/off() chaining returns the proxy, never the raw object
      return MAPPED_RESULTS.has(prop) ? gate.mapValue(result) : result;
    };
    Object.defineProperty(wrapper, "name", { value: name });
    return wrapper;
  }
}

function describeCall(name: string, args: unknown[]): string {
  const a = args[0];
  if (typeof a === "string") return `${name}(${JSON.stringify(a.length > 80 ? a.slice(0, 77) + "..." : a)})`;
  if (typeof a === "number" && typeof args[1] === "number") return `${name}(${a}, ${args[1]})`;
  return `${name}()`;
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
  let transformed: TransformResult;
  try {
    transformed = transformScript(req.script);
  } catch (err) {
    const e = err as ScriptSyntaxError;
    emit({ type: "error", kind: "script", name: "SyntaxError", message: e.message });
    finished = true;
    return { exitCode: EXIT_ERROR };
  }

  const gate = new RunGate();
  const touched = new Map<Page, { name: string | null }>();
  const pageLines: string[] = [];
  let droppedPageLines = 0;
  const pushPageLine = (line: string) => {
    if (pageLines.length < DEFAULTS.pageConsoleMaxLines) pageLines.push(line.slice(0, 500));
    else droppedPageLines++;
  };
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
  const cleanup = (reason: string) => {
    clearTimeout(timer);
    gate.close(reason);
    ctx.signal.removeEventListener("abort", onAbort);
    for (const off of listeners) off();
    if (droppedPageLines > 0) pageLines.push(`[page] ... ${droppedPageLines} more line${droppedPageLines === 1 ? "" : "s"}`);
    if (pageLines.length > 0) stderr(pageLines.join("\n") + "\n");
    if (entry) {
      entry.activeRuns = Math.max(0, entry.activeRuns - 1);
      ctx.manager.touch(entry);
    }
  };
  const finish = (exitCode: number, reason: string) => {
    if (finished) return;
    cleanup(reason);
    finished = true;
    resolveOutcome({ exitCode });
  };
  const timer = setTimeout(() => {
    const err = new DeadlineError(Math.round(req.timeoutMs / 1000), gate.lastInflight());
    // Stop the script at its next page call right away; the error frame follows.
    gate.close("deadline passed");
    deadlineReject(err);
    if (finished) return;
    void buildErrorFrame(err, req.scriptName, touched, 0, transformed, { gate, entry, manager: ctx.manager }).then((frame) => {
      if (finished) return;
      emit(frame);
      finish(EXIT_TIMEOUT, "deadline passed");
    });
  }, remaining());
  const onAbort = () => {
    // Client gone: nobody will read frames; end the run now so the script stops at its next page call.
    gate.close("aborted (client disconnected)");
    deadlineReject(new AbortedError());
    finish(EXIT_ERROR, "aborted (client disconnected)");
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  const track = (page: Page, name: string | null) => {
    if (touched.has(page)) return;
    touched.set(page, { name });
    // Per-page defaults a previous script may have changed: every run starts from the documented values.
    try {
      page.setDefaultTimeout(DEFAULTS.actionTimeoutMs);
      page.setDefaultNavigationTimeout(DEFAULTS.navigationTimeoutMs);
    } catch {
      /* closed page */
    }
    if (req.quietPage) return;
    const label = () => `[page${name ? ":" + name : ""}]`;
    const onConsole = (msg: ConsoleMessage) => {
      const t = msg.type() as string;
      if (t !== "error" && t !== "warn" && t !== "warning") return;
      let url = "";
      try {
        url = msg.location()?.url ?? "";
      } catch {
        /* ignore */
      }
      if (url.endsWith("/favicon.ico")) return; // every dev server 404s this probe
      let text = msg.text();
      if (url && /^Failed to load resource/.test(text)) text += ` (${url})`;
      pushPageLine(`${label()} ${t === "error" ? "error" : "warn"}: ${text}`);
    };
    const onPageError = (e: unknown) => {
      const err = e as Error | undefined;
      pushPageLine(`${label()} uncaught: ${err?.message ?? String(e)}`);
    };
    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    const offHook = addPageLineHook(page, (text) => pushPageLine(`${label()} ${text}`));
    listeners.push(() => {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      offHook();
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
    gate.onPage = (p) => track(p, pages.nameOf(p));

    // ---- globals
    const browserApi = Object.freeze({
      getPage: async (name: string) => {
        if (gate.finished) return gate.abortedCall();
        const p = await pages.getPage(name);
        track(p, pages.nameOf(p) ?? (looksLikeId(name) ? null : name));
        return gate.guard(p, "page");
      },
      newPage: async () => {
        if (gate.finished) return gate.abortedCall();
        const p = await pages.newPage();
        track(p, null);
        return gate.guard(p, "page");
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
      if (gate.finished) throw new RunAbortedError(gate.reason);
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
      ...gate.timerGlobals(),
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
    const value = await Promise.race([withRun({ id: req.id, emit, gate }, () => fn()), deadlinePromise]);
    const rendered = renderResult(value);
    if (rendered !== undefined) {
      const frame: ResultFrame & { data?: unknown } = { type: "result", value: rendered.text };
      if ("data" in rendered) frame.data = rendered.data;
      emit(frame);
    }
    return EXIT_OK;
  })().then(
    (code) => finish(code, "ended"),
    async (err) => {
      if (finished) return;
      if (err instanceof DeadlineError) return; // the timer owns the timeout frame
      if (err instanceof AbortedError) return; // onAbort already finished the run
      if (err instanceof RunAbortedError) return; // a zombie hit the closed gate; the deadline/abort path owns the outcome
      const frame = await buildErrorFrame(err, req.scriptName, touched, remaining(), transformed, { gate, entry, manager: ctx.manager });
      if (finished) return;
      emit(frame);
      finish(EXIT_ERROR, "ended");
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

/** Puppeteer's wording when the browser goes away under a call. */
const BROWSER_GONE_RE = /Target closed|Session closed|Connection closed|Browser (was )?disconnected|detached Frame|Navigating frame was detached|Protocol error.*(closed|disconnected)/i;

export class BrowserStoppedError extends Error {
  constructor(key: string) {
    super(`browser "${key}" was stopped while the script was running`);
    this.name = "BrowserStoppedError";
  }
}

async function buildErrorFrame(
  err: unknown,
  scriptName: string,
  touched: Map<Page, { name: string | null }>,
  remainingMs: number,
  transformed?: Pick<TransformResult, "columnShifts" | "returnInsert">,
  run?: { gate: RunGate; entry: BrowserEntry | null; manager: BrowserManager },
): Promise<ErrorFrame> {
  const gate = run?.gate;
  const entry = run?.entry;
  // `doobie stop` (or a crashed Chrome) under a running script: name the cause instead of Puppeteer's
  // symptom. stop() removes the entry from the manager before closing, so either signal identifies it.
  if (entry && !(err instanceof DeadlineError) && !(err instanceof AbortedError)) {
    const msg = String((err as Error | undefined)?.message ?? err);
    const stopped = !entry.browser.connected || run!.manager.peek(entry.key) !== entry;
    if (stopped && BROWSER_GONE_RE.test(msg)) {
      const e = new BrowserStoppedError(entry.key);
      return { type: "error", kind: "daemon", name: e.name, message: e.message };
    }
  }
  const pages = await describePages(touched, Math.min(1500, Math.max(200, remainingMs)), gate);
  if (err instanceof DeadlineError) {
    return { type: "error", kind: "timeout", name: "TimeoutError", message: err.message, pages };
  }
  if (err instanceof AbortedError) {
    return { type: "error", kind: "daemon", name: "AbortedError", message: err.message, pages };
  }
  if (err instanceof ChromeNotFoundError || err instanceof CdpConnectError) {
    return { type: "error", kind: "daemon", name: err.name, message: err.message };
  }
  const f = formatScriptError(err, scriptName, { columnShifts: transformed?.columnShifts, returnInsert: transformed?.returnInsert });
  return { type: "error", kind: "script", name: f.name, message: f.message, stack: f.stack, pages };
}

async function describePages(touched: Map<Page, { name: string | null }>, budgetMs: number, gate?: RunGate): Promise<PageInfo[]> {
  const out: PageInfo[] = [];
  const jobs = [...touched.entries()].map(async ([page, meta]) => {
    if (page.isClosed()) return;
    let url = safeUrl(page);
    // After a failed goto, page.url() still reports the previous document (or about:blank);
    // say which navigation failed so the agent knows where the page actually stopped.
    const failed = gate?.lastFailed;
    if (failed && failed.target === page && /\.goto$/.test(failed.name) && typeof failed.arg === "string" && failed.arg !== url) {
      url += ` (goto ${JSON.stringify(failed.arg)} failed)`;
    }
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
