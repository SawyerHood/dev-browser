/**
 * Shared HTTP route handlers for page operations.
 *
 * These routes are used by both standalone (index.ts) and external browser
 * (external-browser.ts) modes. They handle all page-level operations like
 * navigation, evaluation, screenshots, etc.
 */

import type { Express, Request, Response } from "express";
import type { Page } from "playwright";
import { getSnapshotScript } from "./snapshot/browser-script.js";

/** Page entry in the registry */
export interface PageEntry {
  page: Page;
  targetId: string;
}

/** Registry type for page tracking */
export type PageRegistry = Map<string, PageEntry>;

/**
 * Register all page operation routes on an Express app.
 *
 * This registers routes for:
 * - POST /pages/:name/navigate
 * - POST /pages/:name/evaluate
 * - GET /pages/:name/snapshot
 * - POST /pages/:name/select-ref
 * - POST /pages/:name/click
 * - POST /pages/:name/fill
 * - POST /pages/:name/screenshot
 * - POST /pages/:name/set-viewport
 * - POST /pages/:name/wait-for-selector
 * - GET /pages/:name/info
 */
export function registerPageRoutes(app: Express, registry: PageRegistry): void {
  // POST /pages/:name/navigate - navigate to URL
  app.post("/pages/:name/navigate", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: "page not found" });
      return;
    }

    const { url, waitUntil } = req.body as { url?: string; waitUntil?: "load" | "domcontentloaded" | "networkidle" };
    if (!url) {
      res.status(400).json({ error: "url is required" });
      return;
    }

    try {
      await entry.page.goto(url, { waitUntil: waitUntil || "domcontentloaded" });
      res.json({
        url: entry.page.url(),
        title: await entry.page.title(),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/evaluate - evaluate JavaScript
  app.post("/pages/:name/evaluate", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: "page not found" });
      return;
    }

    const { expression } = req.body as { expression?: string };
    if (!expression) {
      res.status(400).json({ error: "expression is required" });
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await entry.page.evaluate((expr: string) => eval(expr), expression);
      res.json({ result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /pages/:name/snapshot - get AI snapshot
  app.get("/pages/:name/snapshot", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: "page not found" });
      return;
    }

    try {
      const snapshotScript = getSnapshotScript();
      const snapshot = await entry.page.evaluate((script: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = globalThis as any;
        if (!w.__devBrowser_getAISnapshot) {
          // eslint-disable-next-line no-eval
          eval(script);
        }
        return w.__devBrowser_getAISnapshot();
      }, snapshotScript);

      res.json({ snapshot });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/select-ref - get element info by ref
  app.post("/pages/:name/select-ref", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: "page not found" });
      return;
    }

    const { ref } = req.body as { ref?: string };
    if (!ref) {
      res.status(400).json({ error: "ref is required" });
      return;
    }

    try {
      const elementInfo = await entry.page.evaluate((refId: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = globalThis as any;
        const refs = w.__devBrowserRefs;
        if (!refs) {
          throw new Error("No snapshot refs found. Call snapshot first.");
        }
        const element = refs[refId];
        if (!element) {
          return { found: false };
        }
        return {
          found: true,
          tagName: element.tagName,
          textContent: element.textContent?.slice(0, 500),
        };
      }, ref);

      res.json(elementInfo);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/click - click on element by ref
  app.post("/pages/:name/click", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: "page not found" });
      return;
    }

    const { ref } = req.body as { ref?: string };
    if (!ref) {
      res.status(400).json({ error: "ref is required" });
      return;
    }

    try {
      const elementHandle = await entry.page.evaluateHandle((refId: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = globalThis as any;
        const refs = w.__devBrowserRefs;
        if (!refs) throw new Error("No snapshot refs found. Call snapshot first.");
        const element = refs[refId];
        if (!element) throw new Error(`Ref "${refId}" not found`);
        return element;
      }, ref);

      const element = elementHandle.asElement();
      if (!element) {
        res.status(400).json({ error: "Could not get element handle" });
        return;
      }

      await element.click();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/fill - fill input by ref
  app.post("/pages/:name/fill", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: "page not found" });
      return;
    }

    const { ref, value } = req.body as { ref?: string; value?: string };
    if (!ref) {
      res.status(400).json({ error: "ref is required" });
      return;
    }
    if (value === undefined) {
      res.status(400).json({ error: "value is required" });
      return;
    }

    try {
      const elementHandle = await entry.page.evaluateHandle((refId: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = globalThis as any;
        const refs = w.__devBrowserRefs;
        if (!refs) throw new Error("No snapshot refs found. Call snapshot first.");
        const element = refs[refId];
        if (!element) throw new Error(`Ref "${refId}" not found`);
        return element;
      }, ref);

      const element = elementHandle.asElement();
      if (!element) {
        res.status(400).json({ error: "Could not get element handle" });
        return;
      }

      await element.fill(value);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/screenshot - take screenshot
  app.post("/pages/:name/screenshot", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: "page not found" });
      return;
    }

    const { fullPage, selector } = req.body as { fullPage?: boolean; selector?: string };

    try {
      let screenshotBuffer: Buffer;
      if (selector) {
        const element = await entry.page.$(selector);
        if (!element) {
          res.status(400).json({ error: `Selector "${selector}" not found` });
          return;
        }
        screenshotBuffer = await element.screenshot();
      } else {
        screenshotBuffer = await entry.page.screenshot({ fullPage: fullPage ?? false });
      }
      const base64 = screenshotBuffer.toString("base64");
      res.json({ screenshot: base64, mimeType: "image/png" });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/set-viewport - set viewport size
  app.post("/pages/:name/set-viewport", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: "page not found" });
      return;
    }

    const { width, height } = req.body as { width?: number; height?: number };
    if (!width || !height) {
      res.status(400).json({ error: "width and height are required" });
      return;
    }

    try {
      await entry.page.setViewportSize({ width, height });
      res.json({ success: true, width, height });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/wait-for-selector - wait for element
  app.post("/pages/:name/wait-for-selector", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: "page not found" });
      return;
    }

    const { selector, timeout, state } = req.body as {
      selector?: string;
      timeout?: number;
      state?: "attached" | "detached" | "visible" | "hidden";
    };
    if (!selector) {
      res.status(400).json({ error: "selector is required" });
      return;
    }

    try {
      await entry.page.waitForSelector(selector, {
        timeout: timeout ?? 30000,
        state: state ?? "visible"
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /pages/:name/info - get page URL and title
  app.get("/pages/:name/info", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: "page not found" });
      return;
    }

    try {
      res.json({
        url: entry.page.url(),
        title: await entry.page.title(),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
