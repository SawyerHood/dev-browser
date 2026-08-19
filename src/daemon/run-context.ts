/**
 * Per-run context available to page helpers (e.g. page.shot emits an image
 * frame). Propagated with AsyncLocalStorage so concurrent runs never mix.
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
