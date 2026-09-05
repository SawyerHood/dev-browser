/** Cross-origin traversal and document-scoped iframe ref lifecycle. */
import { test, expect, afterAll, beforeAll } from "bun:test";
import { withPage, closeBrowser, type DevBrowserPage } from "./helpers/browser.ts";
import { startServer, type FixtureServer } from "./helpers/server.ts";

let parent: FixtureServer;
let remote: FixtureServer;
let crossUrl: string;

beforeAll(async () => {
  remote = await startServer({
    "/cross": `<button id="cross" onclick="this.textContent='Cross clicked'">Cross child</button>`,
  });
  // A different hostname makes this cross-site as well as cross-origin, so
  // Chrome may move it through an out-of-process renderer.
  crossUrl = remote.url("/cross").replace("127.0.0.1", "localhost");
  parent = await startServer({
    "/child": `<button id="same" onclick="this.textContent='Same clicked'">Same child</button>`,
    "/host": `<iframe id="child" src="/child"></iframe>`,
  });
});

afterAll(async () => {
  await closeBrowser();
  await parent?.stop();
  await remote?.stop();
});

function childRef(snapshot: string, label: string): string {
  const ref = new RegExp(`- button "${label}" \\[ref=(f\\d+e\\d+)\\]`).exec(snapshot)?.[1];
  if (!ref) throw new Error(`No frame ref for ${label} in:\n${snapshot}`);
  return ref;
}

function frameKey(ref: string): string {
  return /^f\d+/.exec(ref)![0];
}

async function sameFrame(page: DevBrowserPage) {
  await page.waitForFunction(() => !!document.querySelector<HTMLIFrameElement>("#child")?.contentDocument?.querySelector("#same"));
  return page.frames().find((frame) => frame !== page.mainFrame())!;
}

async function navigateChild(page: DevBrowserPage, url: string) {
  const arrived = page.waitForFrame((candidate) => candidate !== page.mainFrame() && candidate.url() === url);
  await page.$eval("#child", (element, next) => {
    (element as HTMLIFrameElement).src = next;
  }, url);
  return await arrived;
}

async function expectOldRefRejected(page: DevBrowserPage, ref: string): Promise<void> {
  await expect(page.ref(ref)).rejects.toThrow(new RegExp(`Frame ${frameKey(ref)} .* (gone|navigated)`));
  await expect(page.click(`ref/${ref}`)).rejects.toThrow(new RegExp(`Frame ${frameKey(ref)} .* (gone|navigated)`));
}

test("frame refs survive same-document navigation but never alias after reload, renderer swap, parent reload, or detach", async () => {
  await withPage(async (page) => {
    await page.goto(parent.url("/host"));
    let frame = await sameFrame(page);
    const initial = childRef((await page.snapshot()) as string, "Same child");

    await frame.evaluate(() => {
      location.hash = "same-document";
    });
    const afterHash = childRef((await page.snapshot()) as string, "Same child");
    expect(afterHash).toBe(initial);
    expect(await (await page.ref(initial)).evaluate((e) => e.id)).toBe("same");

    // Same URL, new document. A fresh snapshot may reuse local eN, but must
    // allocate a new fN before the old ref is checked.
    await frame.goto(frame.url().replace(/#.*$/, ""), { waitUntil: "domcontentloaded" });
    const afterReload = childRef((await page.snapshot()) as string, "Same child");
    expect(frameKey(afterReload)).not.toBe(frameKey(initial));
    await expectOldRefRejected(page, initial);

    // Cross-site navigation can swap the renderer while Puppeteer retains the
    // logical frame. It is still traversable, and gets a new document key.
    frame = await navigateChild(page, crossUrl);
    const cross = childRef((await page.snapshot()) as string, "Cross child");
    expect(frameKey(cross)).not.toBe(frameKey(afterReload));
    await expectOldRefRejected(page, afterReload);
    await page.click(`ref/${cross}`);
    expect(await (await page.ref(cross)).evaluate((e) => e.textContent)).toBe("Cross clicked");

    frame = await navigateChild(page, parent.url("/child"));
    const backToSame = childRef((await page.snapshot()) as string, "Same child");
    expect(frameKey(backToSame)).not.toBe(frameKey(cross));
    await expectOldRefRejected(page, cross);

    frame = await navigateChild(page, crossUrl);
    const crossAgain = childRef((await page.snapshot()) as string, "Cross child");
    expect(frameKey(crossAgain)).not.toBe(frameKey(backToSame));
    await expectOldRefRejected(page, backToSame);

    await page.reload({ waitUntil: "domcontentloaded" });
    await sameFrame(page);
    const afterParentReload = childRef((await page.snapshot()) as string, "Same child");
    expect(frameKey(afterParentReload)).not.toBe(frameKey(crossAgain));
    await expectOldRefRejected(page, crossAgain);

    await page.$eval("#child", (element) => element.remove());
    await page.snapshot();
    await expectOldRefRejected(page, afterParentReload);
  });
});

test("a frame unavailable during host lookup is marked unavailable, not cross-origin", async () => {
  await withPage(async (page) => {
    await page.setContent(`<iframe id="gone" srcdoc="<button>Too late</button>"></iframe>`);
    await page.waitForFunction(() => !!document.querySelector<HTMLIFrameElement>("#gone")?.contentDocument?.body.children.length);

    // Simulate the real detach/navigation race between the in-page DOM walk
    // and the host's contentFrame() lookup, without relying on timing.
    const handle = (await page.$("#gone"))!;
    const prototype = Object.getPrototypeOf(handle) as { contentFrame: () => Promise<unknown> };
    const contentFrame = prototype.contentFrame;
    try {
      prototype.contentFrame = async () => null;
      const snapshot = (await page.snapshot()) as string;
      expect(snapshot).toMatch(/- iframe \[ref=e\d+\] \[unavailable\]/);
      expect(snapshot).not.toContain("[cross-origin]");
      expect(snapshot).not.toContain("Too late");
    } finally {
      prototype.contentFrame = contentFrame;
      await handle.dispose();
    }
  });
});

test("delayed frame ref queries and actions cannot cross a document boundary", async () => {
  await withPage(async (page) => {
    await page.goto(parent.url("/host"));
    let frame = await sameFrame(page);
    const first = childRef((await page.snapshot()) as string, "Same child");

    // Pause after resolveRefFrame's synchronous document check but before the
    // Puppeteer query begins. Reload and snapshot the new document in that gap.
    const originalQuery = frame.$;
    let releaseQuery!: () => void;
    let queryEntered!: () => void;
    const queryGate = new Promise<void>((resolve) => (releaseQuery = resolve));
    const atQuery = new Promise<void>((resolve) => (queryEntered = resolve));
    frame.$ = (async function (this: typeof frame, ...args: Parameters<typeof frame.$>) {
      queryEntered();
      await queryGate;
      return await originalQuery.apply(this, args);
    }) as typeof frame.$;
    const delayedRef = page.ref(first);
    await atQuery;
    await frame.goto(frame.url(), { waitUntil: "domcontentloaded" });
    const second = childRef((await page.snapshot()) as string, "Same child");
    releaseQuery();
    await expect(delayedRef).rejects.toThrow(/stale or unknown/);
    frame.$ = originalQuery;

    // Do the same for a side-effecting selector method. The delayed click must
    // fail rather than finding the new document's identically numbered eN.
    frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    const originalClick = frame.click;
    let releaseClick!: () => void;
    let clickEntered!: () => void;
    const clickGate = new Promise<void>((resolve) => (releaseClick = resolve));
    const atClick = new Promise<void>((resolve) => (clickEntered = resolve));
    frame.click = async function (...args: Parameters<typeof frame.click>) {
      clickEntered();
      await clickGate;
      return await originalClick.apply(this, args);
    };
    const delayedClick = page.click(`ref/${second}`);
    await atClick;
    await frame.goto(frame.url(), { waitUntil: "domcontentloaded" });
    const third = childRef((await page.snapshot()) as string, "Same child");
    releaseClick();
    await expect(delayedClick).rejects.toThrow(/stale or unknown/);
    frame.click = originalClick;

    expect(frameKey(second)).not.toBe(frameKey(third));
    expect(await (await page.ref(third)).evaluate((element) => element.textContent)).toBe("Same child");
  });
});

test("a delayed snapshot stays bound to its captured execution context", async () => {
  await withPage(async (page) => {
    await page.goto(parent.url("/host"));
    const frame = await sameFrame(page);
    const oldRef = childRef((await page.snapshot()) as string, "Same child");
    const realm = (frame as unknown as {
      isolatedRealm(): { context?: { evaluate(expression: string): Promise<unknown> } };
    }).isolatedRealm();
    const oldDocument = realm.context!;
    const originalEvaluate = oldDocument.evaluate;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const atOldDocument = new Promise<void>((resolve) => (entered = resolve));
    let paused = false;
    oldDocument.evaluate = async function (expression: string) {
      if (!paused && expression.includes("window.__devBrowser.snapshot")) {
        paused = true;
        entered();
        await gate;
      }
      return await originalEvaluate.call(this, expression);
    };

    const delayedSnapshot = page.snapshot();
    await atOldDocument;
    await frame.goto(frame.url(), { waitUntil: "domcontentloaded" });
    const freshRef = childRef((await page.snapshot()) as string, "Same child");
    release();
    const staleSnapshot = (await delayedSnapshot) as string;

    expect(staleSnapshot).toContain("[unavailable]");
    expect(frameKey(freshRef)).not.toBe(frameKey(oldRef));
    await expectOldRefRejected(page, oldRef);
    expect(await (await page.ref(freshRef)).evaluate((element) => element.id)).toBe("same");
    const currentKey = await (frame as unknown as {
      isolatedRealm(): { evaluate(expression: string): Promise<unknown> };
    }).isolatedRealm().evaluate("window.__devBrowserRefState.frameKey");
    expect(currentKey).toBe(frameKey(freshRef));
  });
});
