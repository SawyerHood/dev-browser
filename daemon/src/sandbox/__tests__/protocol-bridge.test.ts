import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProtocolBridge, type ProtocolBridge } from "../protocol-bridge.js";
import type { PlaywrightClientLike } from "../playwright-internals.js";

describe.sequential("protocol bridge", () => {
  let bridge: ProtocolBridge;
  let playwright: PlaywrightClientLike;
  let browser: Browser | undefined;
  let page: Page | undefined;

  beforeAll(async () => {
    bridge = createProtocolBridge();
    playwright = await bridge.initializePlaywright();
  }, 60_000);

  afterAll(async () => {
    if (page && !page.isClosed()) {
      await page.close();
    }

    if (browser?.isConnected()) {
      await browser.close();
    }

    await bridge.dispose("test teardown");
  }, 60_000);

  it("initializes Playwright through the bridge", () => {
    expect(playwright.chromium).toBeDefined();
  });

  it("launches Chromium and executes core page operations", async () => {
    browser = await playwright.chromium.launch({ headless: true });
    page = await browser.newPage();

    await page.goto("https://example.com");

    await expect(page.title()).resolves.toBe("Example Domain");
    await expect(page.locator("h1").textContent()).resolves.toBe("Example Domain");
    await expect(page.evaluate(() => document.title)).resolves.toBe("Example Domain");
  }, 120_000);

  it("cleans up page, browser, and bridge connection", async () => {
    const activePage = page;
    const activeBrowser = browser;

    expect(activePage).toBeDefined();
    expect(activeBrowser).toBeDefined();

    await activePage?.close();
    expect(activePage?.isClosed()).toBe(true);

    await activeBrowser?.close();
    expect(activeBrowser?.isConnected()).toBe(false);

    await bridge.dispose("test cleanup");
  }, 60_000);
});
