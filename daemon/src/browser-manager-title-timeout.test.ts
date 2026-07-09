import type { Browser, BrowserContext, Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserManager, type BrowserEntry } from "./browser-manager.js";

const browserName = "browser-manager-title-timeout";

type BrowserManagerInternals = {
  browsers: Map<string, BrowserEntry>;
  getPageTargetId: (context: BrowserContext, page: Page) => Promise<string | null>;
};

function createMockEntry(pages: Page | Page[]): BrowserEntry {
  const pageList = Array.isArray(pages) ? pages : [pages];
  const context = {
    pages: () => pageList,
  } as unknown as BrowserContext;

  const browser = {
    contexts: () => [context],
    isConnected: () => true,
  } as unknown as Browser;

  return {
    name: browserName,
    type: "connected",
    browser,
    context,
    pages: new Map(),
    endpoint: "ws://127.0.0.1:9222/devtools/browser/test",
    headless: false,
    ignoreHTTPSErrors: false,
  };
}

describe("BrowserManager listPages title handling", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("falls back to an empty title when page.title never resolves", async () => {
    vi.useFakeTimers();

    const page = {
      isClosed: () => false,
      on: () => undefined,
      title: () => new Promise<string>(() => {}),
      url: () => "chrome://blank",
    } as unknown as Page;

    const manager = new BrowserManager("/tmp/dev-browser-title-timeout");
    const internals = manager as unknown as BrowserManagerInternals;
    internals.browsers.set(browserName, createMockEntry(page));
    vi.spyOn(internals, "getPageTargetId").mockResolvedValue("target-1");

    const pagesPromise = manager.listPages(browserName);
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(pagesPromise).resolves.toEqual([
      {
        id: "target-1",
        name: null,
        title: "",
        url: "chrome://blank",
      },
    ]);
  });

  it("starts every title lookup concurrently and uses one timeout window", async () => {
    vi.useFakeTimers();

    const started: number[] = [];
    const pages = [0, 1, 2].map(
      (index) =>
        ({
          isClosed: () => false,
          on: () => undefined,
          title: () => {
            started.push(index);
            return new Promise<string>(() => {});
          },
          url: () => `chrome://page-${index}`,
        }) as unknown as Page
    );

    const manager = new BrowserManager("/tmp/dev-browser-concurrent-title-timeout");
    const internals = manager as unknown as BrowserManagerInternals;
    internals.browsers.set(browserName, createMockEntry(pages));
    vi.spyOn(internals, "getPageTargetId").mockImplementation(async (_context, page) => {
      return `target-${pages.indexOf(page)}`;
    });

    let settled = false;
    const pagesPromise = manager.listPages(browserName).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(started).toEqual([0, 1, 2]);

    await vi.advanceTimersByTimeAsync(1_499);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pagesPromise).resolves.toEqual([
      { id: "target-0", name: null, title: "", url: "chrome://page-0" },
      { id: "target-1", name: null, title: "", url: "chrome://page-1" },
      { id: "target-2", name: null, title: "", url: "chrome://page-2" },
    ]);
  });

  it("still surfaces page.title errors when the page remains open", async () => {
    const page = {
      isClosed: () => false,
      on: () => undefined,
      title: () => Promise.reject(new Error("title failed")),
      url: () => "chrome://broken",
    } as unknown as Page;

    const manager = new BrowserManager("/tmp/dev-browser-title-errors");
    const internals = manager as unknown as BrowserManagerInternals;
    internals.browsers.set(browserName, createMockEntry(page));
    vi.spyOn(internals, "getPageTargetId").mockResolvedValue("target-2");

    await expect(manager.listPages(browserName)).rejects.toThrow("title failed");
  });
});
