import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "./browser-manager.js";

const browserName = "browser-manager-pages";
const secondaryBrowserName = "browser-manager-pages-secondary";

function createDataUrl(title: string, body: string): string {
  return `data:text/html,${encodeURIComponent(`<title>${title}</title>${body}`)}`;
}

describe.sequential("BrowserManager page discovery", () => {
  let browserRootDir = "";
  let manager: BrowserManager;

  beforeAll(async () => {
    browserRootDir = await mkdtemp(path.join(os.tmpdir(), "dev-browser-manager-pages-"));
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
  }, 180_000);

  afterEach(async () => {
    await manager.stopBrowser(browserName);
    await manager.stopBrowser(secondaryBrowserName);
  }, 180_000);

  afterAll(async () => {
    await manager.stopAll();
    await rm(browserRootDir, {
      recursive: true,
      force: true,
    });
  }, 180_000);

  async function ensureBrowser(): Promise<void> {
    await manager.ensureBrowser(browserName, {
      headless: true,
    });
  }

  it("listPages returns objects with id, url, title, and name fields", async () => {
    await ensureBrowser();

    const anonymousPage = await manager.newPage(browserName);
    await anonymousPage.goto(createDataUrl("Anonymous Tab", "<h1>anonymous</h1>"));

    const pages = await manager.listPages(browserName);
    const anonymousSummary = pages.find(
      (page) => page.name === null && page.title === "Anonymous Tab"
    );

    expect(anonymousSummary).toBeDefined();
    expect(anonymousSummary).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^[a-f0-9]+$/i),
        name: null,
        title: "Anonymous Tab",
        url: expect.stringContaining("data:text/html"),
      })
    );

    for (const page of pages) {
      expect(typeof page.id).toBe("string");
      expect(typeof page.url).toBe("string");
      expect(typeof page.title).toBe("string");
      expect(page.name === null || typeof page.name === "string").toBe(true);
    }
  }, 120_000);

  it("listPages includes pages created via getPage with their name", async () => {
    await ensureBrowser();

    const namedPage = await manager.getPage(browserName, "dashboard");
    await namedPage.goto(createDataUrl("Dashboard", "<main>named page</main>"));

    await expect(manager.listPages(browserName)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^[a-f0-9]+$/i),
          name: "dashboard",
          title: "Dashboard",
          url: expect.stringContaining("data:text/html"),
        }),
      ])
    );
  }, 120_000);

  it("getPage accepts a targetId for an existing tab", async () => {
    await ensureBrowser();

    const existingPage = await manager.newPage(browserName);
    await existingPage.goto(createDataUrl("Target Tab", "<p>existing tab</p>"));

    const targetSummary = (await manager.listPages(browserName)).find(
      (page) => page.name === null && page.title === "Target Tab"
    );

    expect(targetSummary).toBeDefined();

    const connectedPage = await manager.getPage(browserName, targetSummary!.id);

    expect(connectedPage).toBe(existingPage);
    expect(
      (await manager.listPages(browserName)).filter((page) => page.title === "Target Tab")
    ).toHaveLength(1);
  }, 120_000);

  it("getPage with a name still returns the existing named page", async () => {
    await ensureBrowser();

    const firstPage = await manager.getPage(browserName, "persist");
    await firstPage.goto(createDataUrl("Persist", "<div>same page</div>"));
    await firstPage.evaluate(() => {
      window.name = "persisted-state";
    });

    const secondPage = await manager.getPage(browserName, "persist");

    expect(secondPage).toBe(firstPage);
    await expect(secondPage.evaluate(() => window.name)).resolves.toBe("persisted-state");
    expect(
      (await manager.listPages(browserName)).filter((page) => page.name === "persist")
    ).toHaveLength(1);
  }, 120_000);

  it("stopBrowser closes launched browser pages before removing the browser", async () => {
    await ensureBrowser();

    const namedPage = await manager.getPage(browserName, "cleanup");
    const anonymousPage = await manager.newPage(browserName);

    await namedPage.goto(createDataUrl("Cleanup Named", "<div>named</div>"));
    await anonymousPage.goto(createDataUrl("Cleanup Anonymous", "<div>anon</div>"));

    await manager.stopBrowser(browserName);

    expect(namedPage.isClosed()).toBe(true);
    expect(anonymousPage.isClosed()).toBe(true);
    expect(manager.listBrowsers()).toEqual([]);
  }, 120_000);

  it("listPagesAcrossBrowsers returns browser metadata for every managed browser", async () => {
    await ensureBrowser();
    await manager.ensureBrowser(secondaryBrowserName, {
      headless: true,
    });

    const defaultPage = await manager.getPage(browserName, "dashboard");
    const secondaryPage = await manager.getPage(secondaryBrowserName, "reports");

    await defaultPage.goto(createDataUrl("Dashboard", "<main>default browser</main>"));
    await secondaryPage.goto(createDataUrl("Reports", "<main>secondary browser</main>"));

    await expect(manager.listPagesAcrossBrowsers()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          browser: browserName,
          name: "dashboard",
          title: "Dashboard",
        }),
        expect.objectContaining({
          browser: secondaryBrowserName,
          name: "reports",
          title: "Reports",
        }),
      ])
    );
  }, 120_000);

  it("listPagesAcrossBrowsers can filter to one browser", async () => {
    await ensureBrowser();
    await manager.ensureBrowser(secondaryBrowserName, {
      headless: true,
    });

    const defaultPage = await manager.getPage(browserName, "main");
    const secondaryPage = await manager.getPage(secondaryBrowserName, "secondary");

    await defaultPage.goto(createDataUrl("Main", "<main>default browser</main>"));
    await secondaryPage.goto(createDataUrl("Secondary", "<main>secondary browser</main>"));

    const pages = await manager.listPagesAcrossBrowsers(browserName);

    expect(pages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          browser: browserName,
          name: "main",
          title: "Main",
        }),
      ])
    );
    expect(pages.every((page) => page.browser === browserName)).toBe(true);
  }, 120_000);
});
