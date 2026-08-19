/**
 * Test fixture: one shared headless Chrome for the test file, fresh page per test.
 * Uses puppeteer directly (no daemon) so page helpers can be unit tested.
 */
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { findChrome } from "../../src/shared/chrome.ts";
import { extendPage, type DoobiePage } from "../../src/page/extend.ts";

let browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (browser && browser.connected) return browser;
  const chrome = findChrome();
  if (!chrome) throw new Error("no Chrome found for tests; set DOOBIE_CHROME");
  browser = await puppeteer.launch({
    executablePath: chrome.path,
    headless: true,
    args: ["--no-sandbox", "--no-first-run", "--disable-search-engine-choice-screen"],
    defaultViewport: { width: 1280, height: 720 },
    protocolTimeout: 30_000,
  });
  return browser;
}

export async function newPage(): Promise<DoobiePage> {
  const b = await getBrowser();
  const page = await b.newPage();
  return extendPage(page);
}

/** Run fn with a fresh page; closes it afterwards. */
export async function withPage<T>(fn: (page: DoobiePage) => Promise<T>): Promise<T> {
  const page = await newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

export type { Page, DoobiePage };
