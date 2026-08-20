/**
 * Attach doobie helpers to a Puppeteer Page. Idempotent per Page instance.
 *
 * Adds: page.snapshot, page.ref, page.shot, page.waitForLoad, page.fill.
 * Changes: goto defaults to waitUntil "domcontentloaded"; default action
 * timeout 5 s and navigation timeout 15 s; `ref/` selectors work everywhere
 * (the ref map lives in Puppeteer's isolated realm, where custom query
 * handlers run) and frame-prefixed refs (`ref/f1e5`) route to the owning frame.
 *
 * Background tabs: Chrome stops acking input events and producing frames for
 * tabs that are not in front, so page.click/hover/mouse/shot on any page
 * other than the most recently activated one would hang. Every input or
 * screenshot action first brings its page to the front (one cheap CDP call,
 * only when the front page actually changes).
 *
 * Dialogs: an unhandled alert/confirm/prompt blocks the renderer forever. A
 * default 'dialog' listener dismisses it and reports it as a page-console
 * line unless the script registered its own 'dialog' listener.
 */
import { ElementHandle, type Browser, type Dialog, type GoToOptions, type HTTPResponse, type Page, type WaitForSelectorOptions } from "puppeteer-core";
import { DEFAULTS } from "../shared/config.ts";
import { shot, type ShotOptions, type ShotResult } from "./shot.ts";
import { fill } from "./fill.ts";
import { waitForLoad, installLoadTracker, type WaitForLoadOptions, type WaitForLoadResult } from "./wait-for-load.ts";
import { pageLine } from "../daemon/run-context.ts";
import {
  snapshot,
  resolveRef,
  resolveRefFrame,
  registerRefQueryHandler,
  REF_SELECTOR_PREFIX,
  type SnapshotOptions,
  type TrackedSnapshot,
} from "./snapshot/index.ts";

export interface DoobiePage extends Page {
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
/* Front-tab tracking                                                  */
/* ------------------------------------------------------------------ */

const FRONT = new WeakMap<Browser, Page>();
const FRONT_TRACKED = new WeakSet<Browser>();

function browserOf(page: Page): Browser | null {
  try {
    return page.browser();
  } catch {
    return null;
  }
}

/**
 * Bring `page` to the front unless it is already the page most recently
 * brought to front in its browser. A new page target (tab opened by the
 * script or by a popup) invalidates the cache, as does the front page closing.
 */
export async function ensureFront(page: Page): Promise<void> {
  const browser = browserOf(page);
  if (!browser) return;
  if (FRONT.get(browser) === page) return;
  if (!FRONT_TRACKED.has(browser)) {
    FRONT_TRACKED.add(browser);
    const invalidate = (t: { type(): string }) => {
      try {
        if (t.type() === "page") FRONT.delete(browser);
      } catch {
        FRONT.delete(browser);
      }
    };
    browser.on("targetcreated", invalidate);
    browser.on("targetdestroyed", invalidate);
    browser.on("disconnected", () => FRONT.delete(browser));
  }
  try {
    await page.bringToFront();
    FRONT.set(browser, page);
  } catch {
    /* closed page or unsupported target: let the action report the real error */
  }
}

/**
 * ElementHandle actions (handle.click(), page.ref('e5').click(), locator
 * actions) do not go through the page wrappers; patch the prototype once so
 * they bring their page to front first. Puppeteer's scrollIntoViewIfNeeded
 * waits on an IntersectionObserver, which never fires on a hidden tab, so
 * even the pre-click checks hang without this.
 */
const HANDLE_FRONT_METHODS = [
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
  "screenshot",
  "isIntersectingViewport",
  "scrollIntoView",
] as const;
let handlePatched = false;
function patchElementHandle(): void {
  if (handlePatched) return;
  handlePatched = true;
  const proto = ElementHandle.prototype as unknown as Record<string, unknown>;
  for (const name of HANDLE_FRONT_METHODS) {
    const orig = proto[name];
    if (typeof orig !== "function") continue;
    const fn = orig as (...a: unknown[]) => unknown;
    const wrapped = function (this: ElementHandle, ...args: unknown[]) {
      let page: Page | null = null;
      try {
        page = this.frame.page();
      } catch {
        page = null;
      }
      if (!page) return fn.apply(this, args);
      return ensureFront(page).then(() => fn.apply(this, args));
    };
    Object.defineProperty(wrapped, "name", { value: name });
    Object.defineProperty(proto, name, { value: wrapped, writable: true, configurable: true, enumerable: false });
  }
}

/** Test hook: forget which page is in front for `browser`. */
export function resetFront(browser: Browser): void {
  FRONT.delete(browser);
}

/** Wrap every method of an input device (mouse/keyboard/touchscreen) so it brings the page to front first. */
function frontDevice<T extends object>(page: Page, device: T, label: string): T {
  const cache = new Map<PropertyKey, unknown>();
  return new Proxy(device, {
    get(target, prop, _receiver) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      let w = cache.get(prop);
      if (!w) {
        const fn = v as (...a: unknown[]) => unknown;
        w = function (this: unknown, ...args: unknown[]) {
          return ensureFront(page).then(() => fn.apply(target, args));
        };
        Object.defineProperty(w, "name", { value: `${label}.${String(prop)}` });
        cache.set(prop, w);
      }
      return w;
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

export function extendPage(page: Page): DoobiePage {
  if (EXTENDED.has(page)) return page as DoobiePage;
  EXTENDED.add(page);
  registerRefQueryHandler();
  patchElementHandle();
  installLoadTracker(page);

  const p = page as DoobiePage & Record<string, unknown>;

  page.setDefaultTimeout(DEFAULTS.actionTimeoutMs);
  page.setDefaultNavigationTimeout(DEFAULTS.navigationTimeoutMs);

  // goto: default to domcontentloaded (dev servers keep "load" pending forever).
  const origGoto = page.goto.bind(page);
  p.goto = (url: string, options?: GoToOptions): Promise<HTTPResponse | null> =>
    origGoto(url, { waitUntil: "domcontentloaded", ...(options ?? {}) });

  // Input devices: bring the page to front before dispatching.
  for (const dev of ["mouse", "keyboard", "touchscreen"] as const) {
    const raw = page[dev] as object | undefined;
    if (!raw) continue;
    Object.defineProperty(p, dev, { value: frontDevice(page, raw, `page.${dev}`), configurable: true, enumerable: false, writable: false });
  }

  // helpers
  p.snapshot = (opts?: SnapshotOptions) => snapshot(page, opts);
  p.ref = (id: string) => resolveRef(page, id);
  p.shot = async (opts?: ShotOptions) => {
    await ensureFront(page);
    return shot(page, opts);
  };
  p.waitForLoad = (opts?: WaitForLoadOptions) => waitForLoad(page, opts);
  p.fill = async (selector: string, text: string, opts?: { delay?: number }) => {
    const at = isRefSelector(selector) ? new Error() : null;
    await ensureFront(page);
    try {
      const m = FRAME_REF_RE.exec(selector);
      if (m) return await fill(resolveRefFrame(page, m[1]! + m[2]!), `ref/${m[2]}`, text, opts);
      return await fill(page, selector, text, opts);
    } catch (err) {
      if (at && /no element matches|No element found for selector/i.test(String((err as Error)?.message))) throw staleRefError(selector, err, at);
      throw err;
    }
  };

  // Route ref/fNeM selectors to the owning frame for selector-taking methods;
  // always reject (never throw synchronously); translate stale-ref failures.
  for (const name of SELECTOR_METHODS) {
    const orig = (page as unknown as Record<string, (...a: unknown[]) => unknown>)[name];
    if (typeof orig !== "function") continue;
    const needsFront = (FRONT_METHODS as readonly string[]).includes(name);
    (p as Record<string, unknown>)[name] = async function (this: unknown, selector: unknown, ...rest: unknown[]) {
      const refSel = isRefSelector(selector);
      const at = refSel ? new Error() : null;
      if (needsFront) await ensureFront(page);
      try {
        if (refSel) {
          const m = FRAME_REF_RE.exec(selector);
          if (m) {
            const frame = resolveRefFrame(page, m[1]! + m[2]!) as unknown as Record<string, (...a: unknown[]) => unknown>;
            return await frame[name]!.call(frame, `ref/${m[2]}`, ...rest);
          }
        }
        return await orig.call(page, selector, ...rest);
      } catch (err) {
        if (at && STALE_RE.test(String((err as Error)?.message))) throw staleRefError(selector as string, err, at);
        throw err;
      }
    };
  }

  // screenshot: bring to front first (a background tab never produces a frame).
  const origScreenshot = page.screenshot.bind(page) as (...a: unknown[]) => Promise<unknown>;
  (p as Record<string, unknown>).screenshot = async function (...args: unknown[]) {
    await ensureFront(page);
    return origScreenshot(...args);
  };

  // waitForSelector('ref/e5'): refs are immediate; poll the main realm until present/visible.
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
          throw new Error(`Waiting for selector \`${selector}\` failed: ${timeout}ms exceeded`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    return origWaitForSelector(selector as string, options);
  };

  // locator('ref/e5'): Puppeteer's string locator already understands `ref/` via the
  // custom query handler (it runs in the isolated realm where window.__doobie lives);
  // only frame-prefixed refs need routing to the owning frame.
  const origLocator = page.locator.bind(page);
  (p as Record<string, unknown>).locator = function (selectorOrFunc: unknown) {
    if (typeof selectorOrFunc === "string") {
      const m = FRAME_REF_RE.exec(selectorOrFunc);
      if (m) return resolveRefFrame(page, m[1]! + m[2]!).locator(`ref/${m[2]}`) as never;
    }
    return origLocator(selectorOrFunc as string);
  };

  // Default dialog handling: dismiss unless the script listens for 'dialog' itself.
  page.on("dialog", (dialog: Dialog) => {
    if (page.listenerCount("dialog") > 1) return;
    void dialog
      .dismiss()
      .catch(() => {})
      .then(() => {
        const msg = dialog.message();
        pageLine(page, `dialog ${dialog.type()}: ${msg.length > 200 ? msg.slice(0, 200) + "…" : msg} (auto-dismissed)`);
      });
  });

  return page as DoobiePage;
}
