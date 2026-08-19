/**
 * Attach doobie helpers to a Puppeteer Page. Idempotent per Page instance.
 *
 * Adds: page.snapshot, page.ref, page.shot, page.waitForLoad, page.fill.
 * Changes: goto defaults to waitUntil "domcontentloaded"; default action
 * timeout 5 s and navigation timeout 15 s; `ref/` selectors work in
 * waitForSelector and locator (which use Puppeteer's isolated realm) and
 * frame-prefixed refs (`ref/f1e5`) route to the owning frame.
 */
import type { ElementHandle, Frame, GoToOptions, HTTPResponse, Page, WaitForSelectorOptions } from "puppeteer-core";
import { DEFAULTS } from "../shared/config.ts";
import { shot, type ShotOptions, type ShotResult } from "./shot.ts";
import { fill } from "./fill.ts";
import { waitForLoad, type WaitForLoadOptions, type WaitForLoadResult } from "./wait-for-load.ts";
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

/** Methods whose first argument is a selector and that should route frame refs. */
const SELECTOR_METHODS = ["$", "$$", "$eval", "$$eval", "click", "type", "hover", "focus", "select", "tap", "fill"] as const;

export function extendPage(page: Page): DoobiePage {
  if (EXTENDED.has(page)) return page as DoobiePage;
  EXTENDED.add(page);
  registerRefQueryHandler();

  const p = page as DoobiePage & Record<string, unknown>;

  page.setDefaultTimeout(DEFAULTS.actionTimeoutMs);
  page.setDefaultNavigationTimeout(DEFAULTS.navigationTimeoutMs);

  // goto: default to domcontentloaded (dev servers keep "load" pending forever).
  const origGoto = page.goto.bind(page);
  p.goto = (url: string, options?: GoToOptions): Promise<HTTPResponse | null> =>
    origGoto(url, { waitUntil: "domcontentloaded", ...(options ?? {}) });

  // helpers
  p.snapshot = (opts?: SnapshotOptions) => snapshot(page, opts);
  p.ref = (id: string) => resolveRef(page, id);
  p.shot = (opts?: ShotOptions) => shot(page, opts);
  p.waitForLoad = (opts?: WaitForLoadOptions) => waitForLoad(page, opts);
  p.fill = (selector: string, text: string, opts?: { delay?: number }) => {
    const m = FRAME_REF_RE.exec(selector);
    if (m) return fill(resolveRefFrame(page, m[1]! + m[2]!), `ref/${m[2]}`, text, opts);
    return fill(page, selector, text, opts);
  };

  // Route ref/fNeM selectors to the owning frame for selector-taking methods.
  for (const name of SELECTOR_METHODS) {
    if (name === "fill") continue;
    const orig = (page as unknown as Record<string, (...a: unknown[]) => unknown>)[name];
    if (typeof orig !== "function") continue;
    (p as Record<string, unknown>)[name] = function (this: unknown, selector: unknown, ...rest: unknown[]) {
      if (typeof selector === "string") {
        const m = FRAME_REF_RE.exec(selector);
        if (m) {
          const frame = resolveRefFrame(page, m[1]! + m[2]!) as unknown as Record<string, (...a: unknown[]) => unknown>;
          return frame[name]!.call(frame, `ref/${m[2]}`, ...rest);
        }
      }
      return orig.call(page, selector, ...rest);
    };
  }

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

  // locator('ref/e5'): function locator in the main realm.
  const origLocator = page.locator.bind(page);
  (p as Record<string, unknown>).locator = function (selectorOrFunc: unknown) {
    if (typeof selectorOrFunc === "string" && selectorOrFunc.startsWith(REF_SELECTOR_PREFIX)) {
      const ref = selectorOrFunc.slice(REF_SELECTOR_PREFIX.length);
      const m = FRAME_REF_RE.exec(selectorOrFunc);
      const frame: Frame = m ? resolveRefFrame(page, ref) : page.mainFrame();
      const local = m ? m[2]! : ref;
      // Function locators are serialized; bake the id into the function body.
      const fn = new Function(
        `var api = window.__doobie; return api ? api.ref(${JSON.stringify(local)}) : null;`,
      ) as () => Element | null;
      return frame.locator(fn as unknown as () => Element) as never;
    }
    return origLocator(selectorOrFunc as string);
  };

  return page as DoobiePage;
}
