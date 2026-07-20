import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { BrowserManager } from "./browser-manager.js";
import { removeDirectoryWithRetries } from "./test-cleanup.js";

const browserName = "browser-manager-pages";

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
  }, 180_000);

  afterAll(async () => {
    await manager.stopAll();
    await removeDirectoryWithRetries(browserRootDir);
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

  it("uses stable page ids without CDP target attachment for connected browsers", async () => {
    await ensureBrowser();

    const entry = manager.getBrowser(browserName)!;
    entry.type = "connected";
    const existingPage = await manager.newPage(browserName);
    await existingPage.goto(createDataUrl("Restricted CDP", "<p>existing tab</p>"));
    const newCDPSession = vi.spyOn(existingPage.context(), "newCDPSession");

    const firstSummary = (await manager.listPages(browserName)).find(
      (page) => page.title === "Restricted CDP"
    );
    const secondSummary = (await manager.listPages(browserName)).find(
      (page) => page.title === "Restricted CDP"
    );

    expect(firstSummary).toBeDefined();
    expect(secondSummary?.id).toBe(firstSummary?.id);
    await expect(manager.getPage(browserName, firstSummary!.id)).resolves.toBe(existingPage);
    expect(newCDPSession).not.toHaveBeenCalled();

    const otherBrowserName = `${browserName}-other`;
    try {
      await manager.ensureBrowser(otherBrowserName, { headless: true });
      manager.getBrowser(otherBrowserName)!.type = "connected";
      await expect(manager.getPage(otherBrowserName, firstSummary!.id)).resolves.not.toBe(
        existingPage
      );
    } finally {
      await manager.stopBrowser(otherBrowserName);
    }
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
});
