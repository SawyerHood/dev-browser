/**
 * page.waitForLoad(): bounded "is the page settled" check. Never throws.
 *
 * CONTRACT (settled):
 *   ready when  document.readyState === "complete"
 *           AND no network request started in the last `networkQuietMs` (300)
 *               (ignore requests older than 2 s — websockets, SSE, long polls)
 *           AND no DOM mutations in the last `domQuietMs` (200)
 *   cap at `timeout` ms (default 3000). Poll every 50 ms.
 *   Returns { ready, readyState, pending, ms } where pending = in-flight
 *   requests younger than 2 s. Must tolerate navigations mid-wait (evaluate
 *   errors are swallowed and polling continues).
 *
 * Implementation hint: one page.evaluate installs (idempotently) a tiny
 * tracker on window.__doobieLoad using PerformanceObserver('resource') for
 * request starts, a MutationObserver on documentElement for DOM activity,
 * and fetch/XHR monkeypatches for in-flight counts; a second evaluate reads
 * the state each poll. Keep both evaluates cheap (<1 ms in page).
 *
 * TODO(waitforload-agent): implement.
 */
import type { Page } from "puppeteer-core";

export interface WaitForLoadOptions {
  timeout?: number;
  networkQuietMs?: number;
  domQuietMs?: number;
  pollMs?: number;
}

export interface WaitForLoadResult {
  ready: boolean;
  readyState: string;
  pending: number;
  ms: number;
}

export async function waitForLoad(page: Page, opts: WaitForLoadOptions = {}): Promise<WaitForLoadResult> {
  void page;
  void opts;
  throw new Error("page.waitForLoad is not implemented yet");
}
