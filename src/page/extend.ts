/**
 * Attach dev-browser helpers to a Puppeteer Page. Idempotent per Page instance.
 *
 * Adds: page.snapshot, page.ref, page.shot, page.waitForLoad, page.fill.
 * Changes: goto defaults to waitUntil "domcontentloaded"; default action
 * timeout 5 s and navigation timeout 15 s; `ref/` selectors work everywhere
 * (the ref map lives in Puppeteer's isolated realm, where custom query
 * handlers run) and frame-prefixed refs (`ref/f1e5`) route to the owning frame.
 *
 * Background tabs: Chrome stops acking input events, producing frames and
 * firing requestAnimationFrame for tabs that are not in front, so
 * page.click/hover/mouse/shot and raf-polled waits on any page other than the
 * front one would hang. Every input/screenshot action runs under a per-Browser
 * front lock: `bringToFront()` then the action, serialized against actions on
 * other pages of the same browser (actions on the same page run concurrently
 * and skip the redundant bringToFront). No cache across time: the front tab
 * can change under us (user click, another CDP client), and bringToFront is a
 * ~1 ms round trip. Waits (waitForSelector/waitForFunction) bring their page
 * to front once at the start and register as "waiting": whenever the lock goes
 * idle after an action on another page, the waiting page is brought back.
 *
 * Run gate: ElementHandle/JSHandle/Frame methods consult the calling run (see
 * run-context.ts) so objects that escaped the page proxies stop at their next
 * await once the run ended.
 *
 * Dialogs: an unhandled alert/confirm/prompt blocks the renderer forever. A
 * default 'dialog' listener dismisses it (accepts beforeunload, so the
 * navigation the script asked for proceeds) and reports it as a page-console
 * line unless the script registered its own 'dialog' listener.
 */
import * as pptr from "puppeteer-core";
import {
  ElementHandle,
  JSHandle,
  Frame,
  Locator,
  TimeoutError,
  type Browser,
  type Dialog,
  type GoToOptions,
  type HTTPResponse,
  type Page,
  type WaitForSelectorOptions,
} from "puppeteer-core";
import { DEFAULTS } from "../shared/config.ts";
import { shot, type ShotOptions, type ShotResult } from "./shot.ts";
import { fill } from "./fill.ts";
import { waitForLoad, installLoadTracker, type WaitForLoadOptions, type WaitForLoadResult } from "./wait-for-load.ts";
import { pageLine, abortedByRun, resolveRunPath } from "../daemon/run-context.ts";
import {
  snapshot,
  resolveRef,
  resolveRefFrame,
  registerRefQueryHandler,
  REF_SELECTOR_PREFIX,
  type SnapshotOptions,
  type TrackedSnapshot,
} from "./snapshot/index.ts";

export interface DevBrowserPage extends Page {
  snapshot(opts?: SnapshotOptions): Promise<string | TrackedSnapshot>;
  ref(id: string): Promise<ElementHandle<Element>>;
  shot(opts?: ShotOptions): Promise<ShotResult>;
  waitForLoad(opts?: WaitForLoadOptions): Promise<WaitForLoadResult>;
  fill(selector: string, text: string, opts?: { delay?: number }): Promise<void>;
}

const EXTENDED = new WeakSet<Page>();

const FRAME_REF_RE = /^ref\/(f\d+)(e\d+)$/;
const STALE_RE = /No element found for selector|failed to find element|Node is either not visible|Node is detached/i;

/** Methods whose first argument is a selector and that should route frame refs. */
const SELECTOR_METHODS = ["$", "$$", "$eval", "$$eval", "click", "type", "hover", "focus", "select", "tap"] as const;

/** Page methods that dispatch input or capture frames and therefore need the page in front. */
const FRONT_METHODS = ["click", "hover", "tap", "type", "focus", "select", "screenshot"] as const;

/* ------------------------------------------------------------------ */
/* Front lock                                                          */
/* ------------------------------------------------------------------ */

type AnyFn = (...a: unknown[]) => unknown;

interface FrontState {
  /** Page whose actions currently hold the lock (null when idle). */
  active: Page | null;
  /** Number of in-flight actions on `active`. */
  count: number;
  /** Actions on other pages, FIFO. */
  queue: Array<{ page: Page; start: () => void }>;
  /** Pages with a raf-polled wait in flight (page -> number of waits). */
  waiting: Map<Page, number>;
  /** The page we most recently brought to front under the lock. */
  fronted: Page | null;
}

const FRONTS = new WeakMap<Browser, FrontState>();
/** Puppeteer's own bringToFront per page (extendPage routes page.bringToFront through the lock). */
const ORIG_BRING = new WeakMap<Page, () => Promise<void>>();

function browserOf(page: Page): Browser | null {
  try {
    return page.browser();
  } catch {
    return null;
  }
}

function stateOf(browser: Browser): FrontState {
  let st = FRONTS.get(browser);
  if (!st) {
    st = { active: null, count: 0, queue: [], waiting: new Map(), fronted: null };
    FRONTS.set(browser, st);
  }
  return st;
}

/** Returns true when the lock was taken immediately as a joiner (same page already active). */
function acquire(st: FrontState, page: Page): Promise<boolean> {
  if (st.count > 0 && st.active === page) {
    st.count++;
    return Promise.resolve(true);
  }
  if (st.count === 0) {
    st.active = page;
    st.count = 1;
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    st.queue.push({
      page,
      start: () => {
        st.active = page;
        st.count++;
        resolve(false);
      },
    });
  });
}

function release(st: FrontState): void {
  st.count--;
  if (st.count > 0) return;
  st.count = 0;
  st.active = null;
  pump(st);
}

function pump(st: FrontState): void {
  if (st.count > 0) return;
  if (st.queue.length === 0) {
    refrontWaiting(st);
    return;
  }
  const first = st.queue.shift()!;
  first.start();
  // Every queued action on the same page may run alongside it.
  for (let i = 0; i < st.queue.length; ) {
    if (st.queue[i]!.page === first.page) st.queue.splice(i, 1)[0]!.start();
    else i++;
  }
}

/** Lock idle: if a raf-polled wait is pending on a page that is not in front, bring that page back. */
function refrontWaiting(st: FrontState): void {
  let target: Page | null = null;
  for (const p of st.waiting.keys()) target = p; // most recently registered
  if (!target || target === st.fronted) return;
  void withFront(target, async () => {});
}

async function bringToFront(st: FrontState, page: Page): Promise<void> {
  st.fronted = page;
  try {
    await (ORIG_BRING.get(page) ?? page.bringToFront.bind(page))();
  } catch {
    /* closed page or unsupported target: let the action report the real error */
  }
}

/**
 * Run `action` with `page` in front: takes the browser's front lock, calls
 * bringToFront, runs the action, releases. Actions on the same page join the
 * current holder (nested Puppeteer calls, Promise.all on one page) and skip
 * the redundant bringToFront.
 */
export async function withFront<T>(page: Page, action: () => Promise<T>): Promise<T> {
  const browser = browserOf(page);
  if (!browser) return action();
  const st = stateOf(browser);
  const joined = await acquire(st, page);
  try {
    if (!joined) await bringToFront(st, page);
    return await action();
  } finally {
    release(st);
  }
}

/**
 * Run a raf-polled wait with `page` in front: bring it to front once at the
 * start (under the lock, so it cannot race another page's action) and keep it
 * registered as waiting; the lock brings it back to front whenever it goes
 * idle after serving another page. The wait itself does not hold the lock
 * (holding it for up to the wait's timeout would block every other page).
 */
export async function withFrontWait<T>(page: Page, action: () => Promise<T>): Promise<T> {
  const browser = browserOf(page);
  if (!browser) return action();
  const st = stateOf(browser);
  await withFront(page, async () => {});
  // Move to the end of the map: the most recent waiter wins when the lock goes idle.
  const n = st.waiting.get(page) ?? 0;
  st.waiting.delete(page);
  st.waiting.set(page, n + 1);
  try {
    return await action();
  } finally {
    const left = (st.waiting.get(page) ?? 1) - 1;
    if (left <= 0) st.waiting.delete(page);
    else st.waiting.set(page, left);
    if (st.count === 0 && st.queue.length === 0) refrontWaiting(st);
  }
}

/** Legacy name kept for callers/tests: bring `page` to front under the lock. */
export function ensureFront(page: Page): Promise<void> {
  return withFront(page, async () => {});
}

/** Test hook: the browser's front-lock state. */
export function frontStateFor(browser: Browser): { active: Page | null; count: number; queued: number; waiting: number; fronted: Page | null } {
  const st = stateOf(browser);
  return { active: st.active, count: st.count, queued: st.queue.length, waiting: st.waiting.size, fronted: st.fronted };
}

/* ------------------------------------------------------------------ */
/* Prototype patches: front lock + run gate                            */
/* ------------------------------------------------------------------ */

/**
 * ElementHandle actions (handle.click(), page.ref('e5').click(), locator
 * actions) do not go through the page wrappers; patch the prototypes once so
 * they take the front lock first. Puppeteer's scrollIntoViewIfNeeded waits
 * on an IntersectionObserver, which never fires on a hidden tab, so even the
 * pre-click checks hang without this.
 */
const HANDLE_FRONT = new Set<string>([
  "click",
  "hover",
  "tap",
  "touchStart",
  "touchMove",
  "touchEnd",
  "drag",
  "dragEnter",
  "dragOver",
  "drop",
  "dragAndDrop",
  "type",
  "press",
  "focus",
  "select",
  "screenshot",
  "isIntersectingViewport",
  "scrollIntoView",
  "scrollIntoViewIfNeeded",
]);
const HANDLE_WAIT = new Set<string>(["waitForSelector"]);
/** Every ElementHandle/JSHandle method that talks to the page (gate-checked). */
const HANDLE_GATED = new Set<string>([
  ...HANDLE_FRONT,
  ...HANDLE_WAIT,
  "$",
  "$$",
  "$eval",
  "$$eval",
  "evaluate",
  "evaluateHandle",
  "jsonValue",
  "getProperty",
  "getProperties",
  "isVisible",
  "isHidden",
  "toElement",
  "clickablePoint",
  "boundingBox",
  "boxModel",
  "uploadFile",
  "autofill",
  "contentFrame",
  "backendNodeId",
  "assertConnectedElement",
]);

const FRAME_FRONT = new Set<string>(["click", "hover", "tap", "type", "focus", "select"]);
const FRAME_WAIT = new Set<string>(["waitForSelector", "waitForFunction"]);
const FRAME_GATED = new Set<string>([
  ...FRAME_FRONT,
  ...FRAME_WAIT,
  "$",
  "$$",
  "$eval",
  "$$eval",
  "evaluate",
  "evaluateHandle",
  "goto",
  "waitForNavigation",
  "setContent",
  "content",
  "title",
  "addScriptTag",
  "addStyleTag",
  "frameElement",
  "waitForDevicePrompt",
]);

function pageOfHandle(h: unknown): Page | null {
  try {
    const frame = (h as { frame?: Frame }).frame;
    return frame ? frame.page() : null;
  } catch {
    return null;
  }
}
function pageOfFrame(f: unknown): Page | null {
  try {
    return (f as Frame).page();
  } catch {
    return null;
  }
}

/**
 * Patch the named methods on every prototype in `protos` that defines them.
 * `front`/`wait` methods take the front lock; every listed method rejects
 * when the calling run's gate is closed.
 */
function patchProtos(
  protos: object[],
  gated: Set<string>,
  front: Set<string>,
  wait: Set<string>,
  pageOf: (self: unknown) => Page | null,
): void {
  for (const proto of protos) {
    for (const name of gated) {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (!desc || typeof desc.value !== "function") continue;
      const fn = desc.value as AnyFn;
      const mode = front.has(name) ? "front" : wait.has(name) ? "wait" : "plain";
      const wrapped = function (this: unknown, ...args: unknown[]) {
        const aborted = abortedByRun();
        if (aborted) return aborted;
        if (mode === "plain") return fn.apply(this, args);
        const page = pageOf(this);
        if (!page) return fn.apply(this, args);
        const run = () => fn.apply(this, args) as Promise<unknown>;
        return mode === "front" ? withFront(page, run) : withFrontWait(page, run);
      };
      Object.defineProperty(wrapped, "name", { value: name });
      Object.defineProperty(proto, name, { value: wrapped, writable: true, configurable: true, enumerable: false });
    }
  }
}

/** Rewrite `{ path }` options (first arg object) so relative paths resolve against the caller's cwd. */
function withRunPaths(args: unknown[]): unknown[] {
  const o = args[0];
  if (o && typeof o === "object" && typeof (o as { path?: unknown }).path === "string") {
    return [{ ...(o as object), path: resolveRunPath((o as { path: string }).path) }, ...args.slice(1)];
  }
  return args;
}

/** uploadFile(...paths) and handle.screenshot({ path }): resolve relative paths against the caller's cwd. */
function patchPathArgs(protos: object[]): void {
  for (const proto of protos) {
    const up = Object.getOwnPropertyDescriptor(proto, "uploadFile");
    if (up && typeof up.value === "function") {
      const fn = up.value as AnyFn;
      Object.defineProperty(proto, "uploadFile", {
        value: function (this: unknown, ...paths: unknown[]) {
          return fn.apply(this, paths.map((x) => (typeof x === "string" ? resolveRunPath(x) : x)));
        },
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
    const sc = Object.getOwnPropertyDescriptor(proto, "screenshot");
    if (sc && typeof sc.value === "function") {
      const fn = sc.value as AnyFn;
      Object.defineProperty(proto, "screenshot", {
        value: function (this: unknown, ...args: unknown[]) {
          return fn.apply(this, withRunPaths(args));
        },
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  }
}

/** The CDP subclasses override a few methods (scrollIntoView, uploadFile, goto, jsonValue...); they are runtime exports without typings. */
function cdpProto(name: string): object[] {
  const cls = (pptr as unknown as Record<string, { prototype?: object } | undefined>)[name];
  return cls?.prototype ? [cls.prototype] : [];
}

let protosPatched = false;
function patchPrototypes(): void {
  if (protosPatched) return;
  protosPatched = true;
  // Path rewriting goes innermost (applied first, wrapped by the gate/front patches below).
  patchPathArgs([...cdpProto("CdpElementHandle"), ElementHandle.prototype]);
  patchProtos([...cdpProto("CdpElementHandle"), ElementHandle.prototype], HANDLE_GATED, HANDLE_FRONT, HANDLE_WAIT, pageOfHandle);
  patchProtos([...cdpProto("CdpJSHandle"), JSHandle.prototype], HANDLE_GATED, new Set(), new Set(), () => null);
  patchProtos([...cdpProto("CdpFrame"), Frame.prototype], FRAME_GATED, FRAME_FRONT, FRAME_WAIT, pageOfFrame);
}

/** Wrap every method of an input device (mouse/keyboard/touchscreen) so it runs under the front lock. */
function frontDevice<T extends object>(page: Page, device: T, label: string): T {
  const cache = new Map<PropertyKey, unknown>();
  return new Proxy(device, {
    get(target, prop, _receiver) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      let w = cache.get(prop);
      if (!w) {
        const fn = v as AnyFn;
        w = function (this: unknown, ...args: unknown[]) {
          return withFront(page, () => fn.apply(target, args) as Promise<unknown>);
        };
        Object.defineProperty(w, "name", { value: `${label}.${String(prop)}` });
        cache.set(prop, w);
      }
      return w;
    },
  });
}

/** Locator actions poll with requestAnimationFrame (stable bounding box) before acting: run them under the front lock. */
const LOCATOR_ACTIONS = new Set<PropertyKey>(["click", "fill", "hover", "scroll", "wait", "waitHandle"]);
function frontLocator<T extends object>(page: Page, locator: T): T {
  return new Proxy(locator, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      const fn = v as AnyFn;
      if (LOCATOR_ACTIONS.has(prop)) {
        return (...args: unknown[]) => {
          const aborted = abortedByRun();
          if (aborted) return aborted;
          return withFront(page, () => fn.apply(target, args) as Promise<unknown>);
        };
      }
      return (...args: unknown[]) => {
        const out = fn.apply(target, args);
        return out instanceof Locator ? frontLocator(page, out) : out;
      };
    },
  });
}

/* ------------------------------------------------------------------ */

function staleRefError(selector: string, cause: unknown, at: Error): Error {
  const ref = selector.slice(REF_SELECTOR_PREFIX.length);
  const err = new Error(`Ref "${ref}" is stale or unknown. Take a new page.snapshot() and use a fresh ref.`, { cause });
  // Puppeteer rejections carry no script frames; reuse the ones captured at call time.
  const frames = (at.stack ?? "").split("\n").slice(1).join("\n");
  if (frames) err.stack = `${err.name}: ${err.message}\n${frames}`;
  return err;
}

function isRefSelector(selector: unknown): selector is string {
  return typeof selector === "string" && selector.startsWith(REF_SELECTOR_PREFIX);
}

export function extendPage(page: Page): DevBrowserPage {
  if (EXTENDED.has(page)) return page as DevBrowserPage;
  EXTENDED.add(page);
  registerRefQueryHandler();
  patchPrototypes();
  installLoadTracker(page);

  const p = page as DevBrowserPage & Record<string, unknown>;

  page.setDefaultTimeout(DEFAULTS.actionTimeoutMs);
  page.setDefaultNavigationTimeout(DEFAULTS.navigationTimeoutMs);

  // goto: default to domcontentloaded (dev servers keep "load" pending forever).
  const origGoto = page.goto.bind(page);
  p.goto = (url: string, options?: GoToOptions): Promise<HTTPResponse | null> =>
    origGoto(url, { waitUntil: "domcontentloaded", ...(options ?? {}) });

  // A script's own bringToFront goes through the lock too (so it cannot land between
  // another page's bringToFront and its action, and the lock knows who is in front).
  ORIG_BRING.set(page, page.bringToFront.bind(page));
  (p as Record<string, unknown>).bringToFront = () => withFront(page, async () => {});

  // Input devices: run under the front lock.
  for (const dev of ["mouse", "keyboard", "touchscreen"] as const) {
    const raw = page[dev] as object | undefined;
    if (!raw) continue;
    Object.defineProperty(p, dev, { value: frontDevice(page, raw, `page.${dev}`), configurable: true, enumerable: false, writable: false });
  }

  // helpers
  p.snapshot = (opts?: SnapshotOptions) => snapshot(page, opts);
  p.ref = (id: string) => resolveRef(page, id);
  p.shot = (opts?: ShotOptions) => withFront(page, () => shot(page, opts));
  p.waitForLoad = (opts?: WaitForLoadOptions) => waitForLoad(page, opts);
  p.fill = (selector: string, text: string, opts?: { delay?: number }) => {
    const at = isRefSelector(selector) ? new Error() : null;
    return withFront(page, async () => {
      try {
        const m = FRAME_REF_RE.exec(selector);
        if (m) return await fill(resolveRefFrame(page, m[1]! + m[2]!), `ref/${m[2]}`, text, opts);
        return await fill(page, selector, text, opts);
      } catch (err) {
        if (at && /no element matches|No element found for selector/i.test(String((err as Error)?.message))) throw staleRefError(selector, err, at);
        throw err;
      }
    });
  };

  // Route ref/fNeM selectors to the owning frame for selector-taking methods;
  // always reject (never throw synchronously); translate stale-ref failures.
  for (const name of SELECTOR_METHODS) {
    const orig = (page as unknown as Record<string, AnyFn>)[name];
    if (typeof orig !== "function") continue;
    const needsFront = (FRONT_METHODS as readonly string[]).includes(name);
    const call = async (selector: unknown, rest: unknown[], at: Error | null) => {
      try {
        if (at) {
          const m = FRAME_REF_RE.exec(selector as string);
          if (m) {
            const frame = resolveRefFrame(page, m[1]! + m[2]!) as unknown as Record<string, AnyFn>;
            return await frame[name]!.call(frame, `ref/${m[2]}`, ...rest);
          }
        }
        return await orig.call(page, selector, ...rest);
      } catch (err) {
        if (at && STALE_RE.test(String((err as Error)?.message))) throw staleRefError(selector as string, err, at);
        throw err;
      }
    };
    (p as Record<string, unknown>)[name] = function (this: unknown, selector: unknown, ...rest: unknown[]) {
      const at = isRefSelector(selector) ? new Error() : null;
      return needsFront ? withFront(page, () => call(selector, rest, at)) : call(selector, rest, at);
    };
  }

  // screenshot: under the front lock (a background tab never produces a frame).
  const origScreenshot = page.screenshot.bind(page) as (...a: unknown[]) => Promise<unknown>;
  (p as Record<string, unknown>).screenshot = (...args: unknown[]) => withFront(page, () => origScreenshot(...withRunPaths(args)));
  // pdf({ path }): relative paths resolve against the caller's cwd, like screenshot.
  const origPdf = page.pdf.bind(page) as (...a: unknown[]) => Promise<unknown>;
  (p as Record<string, unknown>).pdf = (...args: unknown[]) => origPdf(...withRunPaths(args));

  // waitForSelector('ref/e5'): refs are immediate; poll the main realm until present/visible.
  // Other selectors: Puppeteer's raf polling (visible/hidden) needs the page in front (Frame patch).
  const origWaitForSelector = page.waitForSelector.bind(page);
  (p as Record<string, unknown>).waitForSelector = async function (selector: unknown, options?: WaitForSelectorOptions) {
    if (typeof selector === "string" && selector.startsWith(REF_SELECTOR_PREFIX)) {
      const ref = selector.slice(REF_SELECTOR_PREFIX.length);
      const timeout = options?.timeout ?? DEFAULTS.actionTimeoutMs;
      const wantVisible = options?.visible ?? false;
      const wantHidden = options?.hidden ?? false;
      const deadline = Date.now() + timeout;
      for (;;) {
        let handle: ElementHandle<Element> | null = null;
        try {
          handle = await resolveRef(page, ref);
        } catch {
          handle = null;
        }
        if (handle) {
          if (!wantVisible && !wantHidden) return handle;
          const visible = await handle.isVisible().catch(() => false);
          if (wantVisible && visible) return handle;
          if (wantHidden && !visible) return null;
          await handle.dispose().catch(() => {});
        } else if (wantHidden) {
          return null;
        }
        if (Date.now() >= deadline) {
          throw new TimeoutError(`Waiting for selector \`${selector}\` failed: Waiting failed: ${timeout}ms exceeded`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    return origWaitForSelector(selector as string, options);
  };

  // locator('ref/e5'): Puppeteer's string locator already understands `ref/` via the
  // custom query handler (it runs in the isolated realm where window.__devBrowser lives);
  // only frame-prefixed refs need routing to the owning frame. Locator actions run
  // under the front lock (their pre-action checks poll with requestAnimationFrame).
  const origLocator = page.locator.bind(page);
  (p as Record<string, unknown>).locator = function (selectorOrFunc: unknown) {
    if (typeof selectorOrFunc === "string") {
      const m = FRAME_REF_RE.exec(selectorOrFunc);
      if (m) return frontLocator(page, resolveRefFrame(page, m[1]! + m[2]!).locator(`ref/${m[2]}`)) as never;
    }
    return frontLocator(page, origLocator(selectorOrFunc as string));
  };

  // Default dialog handling: dismiss unless the script listens for 'dialog' itself.
  // beforeunload is accepted: the script asked to navigate; dismiss would cancel it.
  page.on("dialog", (dialog: Dialog) => {
    if (page.listenerCount("dialog") > 1) return;
    const accept = dialog.type() === "beforeunload";
    void (accept ? dialog.accept() : dialog.dismiss())
      .catch(() => {})
      .then(() => {
        const msg = dialog.message();
        pageLine(page, `dialog ${dialog.type()}: ${msg.length > 200 ? msg.slice(0, 200) + "…" : msg} (auto-${accept ? "accepted" : "dismissed"})`);
      });
  });

  return page as DevBrowserPage;
}
