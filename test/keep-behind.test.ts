/**
 * Someone's own browser (keepBehind): dev-browser never raises its windows for an action.
 * Chrome's Page.bringToFront activates the tab's window, which raises it and takes keyboard
 * focus from whatever the user is in, so these count the calls sent.
 */
import { test, expect, describe, afterAll, beforeAll } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { findChrome } from "../src/shared/chrome.ts";
import { extendPage, keepBehind, type DevBrowserPage } from "../src/page/extend.ts";
import { startServer, type FixtureServer, sleep } from "./helpers/server.ts";

let srv: FixtureServer;
let browser: Browser;
const fronted: string[] = [];

function counted(page: Page, name: string): DevBrowserPage {
  const client = (page as unknown as { _client(): { send: (m: string, ...r: unknown[]) => Promise<unknown> } })._client();
  const send = client.send.bind(client);
  client.send = (method: string, ...rest: unknown[]) => {
    if (method === "Page.bringToFront") fronted.push(name);
    return send(method, ...rest);
  };
  return extendPage(page);
}

beforeAll(async () => {
  srv = await startServer({
    "/btn": `<!doctype html><title>Btn</title><button id=b style="width:200px;height:80px" onclick="window.clicked=(window.clicked||0)+1">go</button>
      <script>window.frames_=0;(function f(){window.frames_++;requestAnimationFrame(f)})()</script>`,
  });
  const chrome = findChrome();
  if (!chrome) throw new Error("no Chrome found for tests; set DEV_BROWSER_CHROME");
  browser = await puppeteer.launch({
    executablePath: chrome.path,
    headless: process.env.DEV_BROWSER_TEST_HEADFUL !== "1",
    args: ["--no-sandbox", "--no-first-run", "--disable-search-engine-choice-screen"],
    defaultViewport: { width: 1280, height: 720 },
    protocolTimeout: 30_000,
  });
  keepBehind(browser);
});
afterAll(async () => {
  await browser?.close().catch(() => {});
  await srv.stop();
});

describe("a browser kept behind", () => {
  test("a page in a window of its own, opened behind: clicks, shots and waits never bring it to front", async () => {
    const theirs = counted(await browser.newPage(), "theirs");
    const ours = counted(await browser.newPage({ type: "window", background: true }), "ours");
    try {
      await theirs.goto(srv.url("/btn"));
      await ours.goto(srv.url("/btn"));
      fronted.length = 0;
      for (let i = 0; i < 3; i++) await ours.click("#b");
      await ours.keyboard.press("a");
      const s = await ours.shot();
      expect(s.width).toBe(1280);
      await ours.evaluate(() => setTimeout(() => ((window as unknown as { flag: boolean }).flag = true), 200));
      await ours.waitForFunction(() => (window as unknown as { flag: boolean }).flag === true, { timeout: 4000 });
      expect(await ours.evaluate(() => (window as unknown as { clicked: number }).clicked)).toBe(3);
      expect(fronted).toEqual([]);
      expect(await theirs.evaluate(() => document.visibilityState)).toBe("visible");
    } finally {
      await ours.close().catch(() => {});
      await theirs.close().catch(() => {});
    }
  }, 30_000);

  test("a background tab: input and raf waits work without front; a shot is brought forward at most once, after the grace", async () => {
    const a = counted(await browser.newPage(), "a");
    const b = counted(await browser.newPage(), "b");
    try {
      await a.goto(srv.url("/btn"));
      await b.goto(srv.url("/btn")); // b opened last: a is a background tab
      fronted.length = 0;
      await a.click("#b");
      await a.click("#b");
      const f0 = await a.evaluate(() => (window as unknown as { frames_: number }).frames_);
      await sleep(300);
      expect(await a.evaluate(() => (window as unknown as { frames_: number }).frames_)).toBeGreaterThan(f0);
      await a.waitForSelector("#b", { visible: true, timeout: 4000 });
      expect(await a.evaluate(() => (window as unknown as { clicked: number }).clicked)).toBe(2);
      expect(fronted).toEqual([]);
      const t0 = Date.now();
      const s = await a.shot();
      expect(s.width).toBe(1280);
      expect(Date.now() - t0).toBeLessThan(6000);
      // Linux Chrome gives a background tab no frame to capture (brought forward once it stalls);
      // macOS Chrome captures it in place.
      expect(fronted.length).toBeLessThanOrEqual(1);
      if (process.platform === "linux") expect(fronted).toEqual(["a"]);
    } finally {
      await a.close().catch(() => {});
      await b.close().catch(() => {});
    }
  }, 30_000);

  test("a script's own page.bringToFront() still brings the page to front", async () => {
    const a = counted(await browser.newPage(), "a");
    try {
      fronted.length = 0;
      await a.bringToFront();
      expect(fronted).toEqual(["a"]);
    } finally {
      await a.close().catch(() => {});
    }
  }, 30_000);
});
