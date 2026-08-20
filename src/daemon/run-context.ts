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

export interface ActiveRun {
  id: string;
  emit: (frame: Frame) => void;
}

const als = new AsyncLocalStorage<ActiveRun>();

export function withRun<T>(run: ActiveRun, fn: () => Promise<T>): Promise<T> {
  return als.run(run, fn);
}

export function currentRun(): ActiveRun | undefined {
  return als.getStore();
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
