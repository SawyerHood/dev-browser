/**
 * Per-run context available to page helpers (e.g. page.shot emits an image
 * frame). Propagated with AsyncLocalStorage so concurrent runs never mix.
 *
 * Page hooks: events that originate outside the script's async chain (CDP
 * callbacks such as a JS dialog) cannot see the AsyncLocalStorage store, so
 * runs register a per-page hook for "page console" lines instead.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Frame } from "../shared/protocol.ts";

/** The part of a run's gate that Puppeteer prototype patches consult (see extend.ts). */
export interface RunGateLike {
  readonly finished: boolean;
  abortedCall(): Promise<never>;
}

export interface ActiveRun {
  id: string;
  emit: (frame: Frame) => void;
  /** Closed once the run ended; handle/frame calls made from the script's async chain are rejected then. */
  gate?: RunGateLike;
  /** The calling client's working directory: relative file paths in scripts resolve against it. */
  cwd?: string;
}

/** Resolve a script-supplied file path against the calling client's cwd (absolute paths pass through). */
export function resolveRunPath(p: string): string {
  if (typeof p !== "string" || p.length === 0 || p.startsWith("/")) return p;
  const base = currentRun()?.cwd;
  if (!base) return p;
  return base.endsWith("/") ? base + p : base + "/" + p;
}

const als = new AsyncLocalStorage<ActiveRun>();

export function withRun<T>(run: ActiveRun, fn: () => Promise<T>): Promise<T> {
  return als.run(run, fn);
}

export function currentRun(): ActiveRun | undefined {
  return als.getStore();
}

/**
 * When the calling run's gate is closed, the rejection a zombie call gets;
 * otherwise null. Cheap enough to sit in front of every ElementHandle/JSHandle/
 * Frame method: objects that escape the page proxies (page.$, mainFrame(),
 * evaluateHandle) still stop at the script's next await after the run ended.
 */
export function abortedByRun(): Promise<never> | null {
  const run = als.getStore();
  if (run?.gate?.finished) return run.gate.abortedCall();
  return null;
}

/* ------------------------------------------------------------------ */
/* Page hooks                                                          */
/* ------------------------------------------------------------------ */

export type PageLineHook = (text: string) => void;

const pageHooks = new WeakMap<object, Set<PageLineHook>>();

/** Register a hook that receives page-console style lines for `page`; returns the unregister function. */
export function addPageLineHook(page: object, hook: PageLineHook): () => void {
  let set = pageHooks.get(page);
  if (!set) {
    set = new Set();
    pageHooks.set(page, set);
  }
  set.add(hook);
  return () => {
    set!.delete(hook);
  };
}

/** Deliver a page-console style line (without the `[page:NAME]` label) to every run that touched `page`. */
export function pageLine(page: object, text: string): void {
  const set = pageHooks.get(page);
  if (!set) return;
  for (const h of set) {
    try {
      h(text);
    } catch {
      /* a hook must never break the emitter */
    }
  }
}
