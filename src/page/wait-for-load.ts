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
 * Implementation: ONE page.evaluate per poll. It idempotently installs a tiny
 * tracker on window.__doobieLoad (PerformanceObserver('resource') for request
 * starts, fetch/XHR patches for in-flight counts, MutationObserver on
 * documentElement for DOM activity) and returns the current state. If the
 * document changed (navigation), the tracker is simply reinstalled.
 *
 * Because the in-page tracker can only see what happens after it is installed,
 * `installLoadTracker(page)` additionally (once per Page) registers the tracker
 * via evaluateOnNewDocument (so future documents get it before any script runs)
 * and listens to Puppeteer request events on the host side (so requests that
 * started before the first waitForLoad() call are still counted). It is called
 * lazily by waitForLoad(); extendPage() should call it eagerly.
 */
import type { HTTPRequest, Page } from "puppeteer-core";
import { DEFAULTS } from "../shared/config.ts";

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

/** Requests older than this are treated as streams/sockets and ignored. */
const STALE_REQUEST_MS = 2000;

interface TrackerState {
  readyState: string;
  /** ms since last request start, or -1 if none recorded. */
  sinceRequest: number;
  /** ms since last DOM mutation, or -1 if none recorded. */
  sinceMutation: number;
  /** in-flight fetch/XHR requests younger than STALE_REQUEST_MS. */
  pending: number;
  /** ms since the tracker was installed in this document. */
  age: number;
}

// Runs in the page. Installs the tracker if missing and returns a snapshot.
function pollInPage(staleMs: number): TrackerState {
  type Tracker = {
    lastRequestStart: number;
    lastMutation: number;
    inFlight: Map<number, number>;
    nextId: number;
    installedAt: number;
  };
  const w = window as unknown as { __doobieLoad?: Tracker };
  let t = w.__doobieLoad;
  if (!t) {
    t = { lastRequestStart: -1, lastMutation: -1, inFlight: new Map(), nextId: 1, installedAt: performance.now() };
    w.__doobieLoad = t;
    const tr = t;
    const now = () => performance.now();

    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          // Chrome's implicit favicon probe is not page activity.
          if (/\/favicon\.ico(\?|$)/.test(e.name)) continue;
          // startTime is relative to timeOrigin, same clock as performance.now().
          if (e.startTime > tr.lastRequestStart) tr.lastRequestStart = e.startTime;
        }
      });
      po.observe({ type: "resource", buffered: true });
    } catch {
      /* no PerformanceObserver */
    }

    const begin = (): number => {
      const id = tr.nextId++;
      const ts = now();
      tr.inFlight.set(id, ts);
      if (ts > tr.lastRequestStart) tr.lastRequestStart = ts;
      return id;
    };
    const end = (id: number): void => {
      tr.inFlight.delete(id);
    };

    try {
      const origFetch = window.fetch;
      if (typeof origFetch === "function") {
        window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
          const id = begin();
          let p: Promise<Response>;
          try {
            p = origFetch.apply(this, args);
          } catch (err) {
            end(id);
            throw err;
          }
          p.then(
            () => end(id),
            () => end(id),
          );
          return p;
        } as typeof fetch;
      }
    } catch {
      /* ignore */
    }

    try {
      const proto = XMLHttpRequest.prototype;
      const origSend = proto.send;
      proto.send = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest["send"]>) {
        const id = begin();
        this.addEventListener("loadend", () => end(id), { once: true });
        return origSend.apply(this, args);
      };
    } catch {
      /* ignore */
    }

    try {
      const mo = new MutationObserver(() => {
        tr.lastMutation = now();
      });
      // Observe the Document node itself: at document-start (evaluateOnNewDocument)
      // documentElement does not exist yet, and a subtree observer on the
      // document still sees every later node.
      mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch {
      /* ignore */
    }
  }

  const n = performance.now();
  let pending = 0;
  for (const [id, ts] of t.inFlight) {
    if (n - ts < staleMs) pending++;
    else t.inFlight.delete(id); // stream / socket / long poll: forget it
  }
  return {
    readyState: document.readyState,
    sinceRequest: t.lastRequestStart < 0 ? -1 : n - t.lastRequestStart,
    sinceMutation: t.lastMutation < 0 ? -1 : n - t.lastMutation,
    pending,
    age: n - t.installedAt,
  };
}

interface HostTracker {
  lastRequestStart: number;
  inFlight: Map<HTTPRequest, number>;
}
const HOST = new WeakMap<Page, HostTracker>();

/**
 * Start tracking network activity for this page (idempotent). Registers the
 * in-page tracker for future documents and host-side request listeners.
 */
export function installLoadTracker(page: Page): void {
  if (HOST.has(page)) return;
  const h: HostTracker = { lastRequestStart: -1, inFlight: new Map() };
  HOST.set(page, h);
  page.on("request", (req) => {
    // The main-frame document request itself is not "activity" to wait for;
    // readyState covers it.
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) return;
    // Chrome's implicit favicon probe is not page activity either.
    if (req.resourceType() === "other" && /\/favicon\.ico(\?|$)/.test(req.url())) return;
    const now = Date.now();
    h.lastRequestStart = now;
    h.inFlight.set(req, now);
  });
  const done = (req: HTTPRequest) => {
    h.inFlight.delete(req);
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  page.on("requestservedfromcache", done);
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) h.inFlight.clear();
  });
  page.evaluateOnNewDocument(pollInPage, STALE_REQUEST_MS).catch(() => {});
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitForLoad(page: Page, opts: WaitForLoadOptions = {}): Promise<WaitForLoadResult> {
  const timeout = opts.timeout ?? DEFAULTS.waitForLoadTimeoutMs;
  const networkQuietMs = opts.networkQuietMs ?? 300;
  const domQuietMs = opts.domQuietMs ?? 200;
  const pollMs = opts.pollMs ?? 50;
  const start = Date.now();
  installLoadTracker(page);
  const host = HOST.get(page)!;

  let readyState = "unknown";
  let pending = 0;

  for (;;) {
    let state: TrackerState | null = null;
    try {
      state = await page.evaluate(pollInPage, STALE_REQUEST_MS);
    } catch {
      state = null; // navigating / context destroyed: keep polling
    }
    if (state) {
      const now = Date.now();
      let hostPending = 0;
      for (const [req, ts] of host.inFlight) {
        if (now - ts < STALE_REQUEST_MS) hostPending++;
        else host.inFlight.delete(req);
      }
      const hostSince = host.lastRequestStart < 0 ? -1 : now - host.lastRequestStart;
      const since = [state.sinceRequest, hostSince].filter((v) => v >= 0);
      const sinceRequest = since.length ? Math.min(...since) : -1;
      readyState = state.readyState;
      pending = Math.max(state.pending, hostPending);
      // Requests older than STALE_REQUEST_MS are ignored; "none yet" is quiet.
      const networkQuiet = sinceRequest < 0 || sinceRequest >= networkQuietMs;
      // "No mutation recorded" only counts as quiet once the tracker has been
      // watching for a full window (the first poll has no history).
      const domQuiet = state.sinceMutation < 0 ? state.age >= domQuietMs : state.sinceMutation >= domQuietMs;
      if (state.readyState === "complete" && networkQuiet && pending === 0 && domQuiet) {
        return { ready: true, readyState, pending, ms: Date.now() - start };
      }
    }
    const elapsed = Date.now() - start;
    if (elapsed >= timeout) return { ready: false, readyState, pending, ms: elapsed };
    await sleep(Math.min(pollMs, timeout - elapsed));
  }
}
