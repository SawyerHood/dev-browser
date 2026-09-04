/**
 * Review round 2 fixes (snapshot-refs): pointer inheritance only from rendered ref'd ancestors,
 * ::before/::after + svg <title> names, iframe padding in [box=...] origins, ref ids surviving an
 * in-page script reinstall, placeholder / file input / caption name fallbacks, ref/ selectors
 * scoped to an element across open shadow roots.
 */
import { test, expect, afterAll, beforeAll } from "bun:test";
import { withPage, closeBrowser, type DevBrowserPage } from "./helpers/browser.ts";
import { startServer, type FixtureServer } from "./helpers/server.ts";
import { INPAGE_VERSION } from "../src/page/snapshot/inpage.ts";

const CHILD = `<!doctype html><body style="margin:0"><button id="inner" style="position:absolute;left:10px;top:20px;width:84px;height:21px">Frame btn</button></body>`;
const GRANDCHILD = `<!doctype html><body style="margin:0"><button id="deep" style="position:absolute;left:5px;top:7px">Deep</button></body>`;
const MID = `<!doctype html><body style="margin:0"><iframe id="g" src="/grandchild" style="position:absolute;left:30px;top:40px;border:0;padding:2px"></iframe></body>`;

let srv: FixtureServer;

beforeAll(async () => {
  srv = await startServer({
    "/child": CHILD,
    "/grandchild": GRANDCHILD,
    "/mid": MID,
    "/padded": `<!doctype html><body style="margin:0"><div style="height:300px"></div><iframe id="f" src="/child" style="margin-left:20px;border:10px solid red;padding:5px;width:400px;height:200px"></iframe></body>`,
    "/nested": `<!doctype html><body style="margin:0"><iframe id="m" src="/mid" style="position:absolute;left:100px;top:200px;border:3px solid blue;padding:4px 6px;width:400px;height:300px"></iframe></body>`,
  });
});

afterAll(async () => {
  await closeBrowser();
  await srv?.stop();
});

async function framesReady(page: DevBrowserPage, n: number) {
  await page.waitForFunction(
    (n) => [...document.querySelectorAll("iframe")].filter((f) => f.contentDocument?.readyState === "complete" && f.contentDocument.body?.children.length).length >= n,
    {},
    n,
  );
}

// 1. pointer inheritance only from an ancestor that itself carries the pointer ref
test("clickable generic keeps its ref under presentation / pointer-events:none / display:contents pointer ancestors", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <div role="presentation" style="cursor:pointer"><div id="a">A: click me</div></div>
      <div style="cursor:pointer;pointer-events:none"><div id="g" style="pointer-events:auto">G</div></div>
      <div style="cursor:pointer;display:contents"><div id="c">C contents</div></div>
      <div style="cursor:pointer"><div id="d">D inherited</div></div>
    `);
    const y = (await page.snapshot()) as string;
    expect(y).toMatch(/- generic \[ref=e\d+\] \[cursor=pointer\]: "A: click me"/);
    expect(y).toMatch(/- generic \[ref=e\d+\] \[cursor=pointer\]: G/);
    expect(y).toMatch(/- generic \[ref=e\d+\] \[cursor=pointer\]: C contents/);
    // a rendered ref'd pointer ancestor still absorbs its descendants
    expect(y).toMatch(/- generic \[ref=e\d+\] \[cursor=pointer\]:\n\s+- generic: D inherited/);
    const i = (await page.snapshot({ interactive: true })) as string;
    expect(i).toMatch(/- generic \[ref=e\d+\] \[cursor=pointer\]: "A: click me"/);
    expect(i).toMatch(/- generic \[ref=e\d+\] \[cursor=pointer\]: G/);
    expect(i).toMatch(/- generic \[ref=e\d+\] \[cursor=pointer\]: C contents/);
    // the refs resolve to the inner elements
    const aRef = /- generic \[ref=(e\d+)\] \[cursor=pointer\]: "A: click me"/.exec(y)![1]!;
    expect(await (await page.ref(aRef)).evaluate((e) => e.id)).toBe("a");
    const gRef = /- generic \[ref=(e\d+)\] \[cursor=pointer\]: G/.exec(y)![1]!;
    expect(await (await page.ref(gRef)).evaluate((e) => e.id)).toBe("g");
  });
});

// 2. ::before/::after content and svg <title> contribute to the name
test("accessible name includes CSS ::before/::after strings and svg <title>", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <style>
        .ico::before { content: "Search" }
        .two::after { content: " " attr(x) url(x.png) "tail" }
        .cnt::before { content: counter(c) }
        .img::before { content: url(x.png) }
      </style>
      <button class="ico"></button>
      <button class="two">Head</button>
      <button class="cnt">Count</button>
      <button class="img">Pic</button>
      <button><svg width="16" height="16"><title>Close dialog</title><path d="M0 0h10v10z"/></svg></button>
      <a href="/"><svg width="16" height="16"><title>Home</title></svg></a>
    `);
    const y = (await page.snapshot()) as string;
    expect(y).toMatch(/- button "Search" \[ref=e\d+\]$/m);
    expect(y).toMatch(/- button "Head tail" \[ref=e\d+\]$/m);
    // non-string content tokens (counters, urls) are ignored
    expect(y).toMatch(/- button "Count" \[ref=e\d+\]$/m);
    expect(y).toMatch(/- button "Pic" \[ref=e\d+\]$/m);
    expect(y).toMatch(/- button "Close dialog" \[ref=e\d+\]:\n\s+- img "Close dialog" \[ref=e\d+\]$/m);
    expect(y).toMatch(/- link "Home" \[ref=e\d+\]:\n\s+- \/url: \/\n\s+- img "Home"/);
    // no stray text lines repeating the title
    expect(y).not.toMatch(/- text: Close dialog/);
    expect(y).not.toMatch(/- img[^\n]*: Close dialog/);
  });
});

// 3. [box=...] origin inside a padded iframe
test("[box=...] inside a padded iframe includes the iframe's border AND padding (nested too)", async () => {
  await withPage(async (page) => {
    await page.goto(srv.url("/padded"));
    await framesReady(page, 1);
    const y = (await page.snapshot({ boxes: true })) as string;
    const m = /- button "Frame btn" \[ref=(f1e\d+)\] \[box=(-?\d+),(-?\d+),(\d+),(\d+)\]/.exec(y);
    expect(m).not.toBeNull();
    const got = [Number(m![2]), Number(m![3]), Number(m![4]), Number(m![5])];
    const h = await page.ref(m![1]!);
    const bb = (await h.boundingBox())!;
    expect(got).toEqual([Math.round(bb.x), Math.round(bb.y), Math.round(bb.width), Math.round(bb.height)]);
    // sanity: margin 20 + border 10 + padding 5 + left 10 = 45
    expect(got[0]).toBe(45);
    expect(got[1]).toBe(300 + 10 + 5 + 20);

    // scoped snapshot into the frame uses the same origin (frameViewportOrigin path)
    const s = (await page.snapshot({ scope: m![1]!, boxes: true })) as string;
    const ms = /\[box=(-?\d+),(-?\d+),/.exec(s)!;
    expect([Number(ms[1]), Number(ms[2])]).toEqual([got[0], got[1]]);
  });
  await withPage(async (page) => {
    await page.goto(srv.url("/nested"));
    await page.waitForFunction(() => {
      const m = document.querySelector<HTMLIFrameElement>("#m");
      const g = m?.contentDocument?.querySelector<HTMLIFrameElement>("#g");
      return !!g?.contentDocument?.querySelector("#deep");
    });
    const y = (await page.snapshot({ boxes: true })) as string;
    const d = /- button "Deep" \[ref=(f\d+e\d+)\] \[box=(-?\d+),(-?\d+),/.exec(y);
    expect(d).not.toBeNull();
    const bb = (await (await page.ref(d![1]!)).boundingBox())!;
    expect([Number(d![2]), Number(d![3])]).toEqual([Math.round(bb.x), Math.round(bb.y)]);
    // 100 + 3 + 6 + 30 + 0 + 2 + 5 = 146 ; 200 + 3 + 4 + 40 + 0 + 2 + 7 = 256
    expect([Number(d![2]), Number(d![3])]).toEqual([146, 256]);
  });
});

// 4. ref ids survive a reinstall of the in-page script (INPAGE_VERSION bump on a long-lived page)
test("reinstalling the in-page script never reuses ref ids already handed out", async () => {
  await withPage(async (page) => {
    await page.setContent(`<button id="old">OLD</button>`);
    const y1 = (await page.snapshot()) as string;
    const oldRef = /- button "OLD" \[ref=(e\d+)\]/.exec(y1)![1]!;
    // simulate a version bump: drop the installed API in the isolated realm (state holder stays, as it would
    // on a real upgrade where only the closure is replaced)
    const realm = (page.mainFrame() as unknown as { isolatedRealm(): { evaluate(fn: () => unknown): Promise<unknown> } }).isolatedRealm();
    await realm.evaluate(() => {
      delete (window as unknown as { __devBrowser?: unknown }).__devBrowser;
    });
    await page.evaluate(() => document.body.prepend(Object.assign(document.createElement("button"), { textContent: "NEW" })));
    const y2 = (await page.snapshot()) as string;
    const newRef = /- button "NEW" \[ref=(e\d+)\]/.exec(y2)![1]!;
    const oldRef2 = /- button "OLD" \[ref=(e\d+)\]/.exec(y2)![1]!;
    expect(oldRef2).toBe(oldRef);
    expect(newRef).not.toBe(oldRef);
    const ids = [...y2.matchAll(/\[ref=(e\d+)\]/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(await (await page.ref(oldRef)).evaluate((e) => e.textContent)).toBe("OLD");
    expect(await (await page.ref(newRef)).evaluate((e) => e.textContent)).toBe("NEW");
    const v = await realm.evaluate(() => (window as unknown as { __devBrowser: { version: number } }).__devBrowser.version);
    expect(v).toBe(INPAGE_VERSION);
  });
});

// 5. name fallbacks: placeholder, file input, legend/figcaption/caption, aria-owns, embedded descendant values
test("name fallbacks: placeholder, 'Choose File', fieldset/figure/table captions, aria-owns, descendant values", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <input placeholder="Search here">
      <textarea placeholder="Notes"></textarea>
      <input placeholder="P" title="T">
      <input type="file" id="f1">
      <label>Resume <input type="file"></label>
      <fieldset><legend>Shipping</legend><input></fieldset>
      <figure><img alt="pic" src="x"><figcaption>Caption A</figcaption></figure>
      <table><caption>Tbl Cap</caption><tr><td>c</td></tr></table>
      <button aria-owns="own1">Own</button><span id="own1">ed text</span>
      <button><span>Qty</span> <input value="3"></button>
      <label>Pick <select><option>A</option><option selected>B</option></select></label>
    `);
    const y = (await page.snapshot()) as string;
    expect(y).toMatch(/- textbox "Search here" \[ref=e\d+\]$/m);
    expect(y).not.toMatch(/\/placeholder: Search here/);
    expect(y).toMatch(/- textbox "Notes" \[ref=e\d+\]$/m);
    // title beats placeholder; the placeholder then stays as a prop
    expect(y).toMatch(/- textbox "T" \[ref=e\d+\]:\n\s+- \/placeholder: P/);
    expect(y).toMatch(/- button "Choose File" \[ref=e\d+\]$/m);
    expect(y).toMatch(/- button "Resume" \[ref=e\d+\]$/m);
    expect(y).toMatch(/- group "Shipping" \[ref=e\d+\]:/);
    expect(y).toMatch(/- figure "Caption A" \[ref=e\d+\]:/);
    expect(y).toMatch(/- table "Tbl Cap" \[ref=e\d+\]:/);
    expect(y).toMatch(/- button "Owned text" \[ref=e\d+\]$/m);
    expect(y).toMatch(/- button "Qty 3" \[ref=e\d+\]:/);
    expect(y).toMatch(/- combobox "Pick" \[ref=e\d+\]:/);
    // the file input ref resolves to the input (uploadFile target)
    const fref = /- button "Choose File" \[ref=(e\d+)\]/.exec(y)![1]!;
    expect(await (await page.ref(fref)).evaluate((e) => (e as HTMLInputElement).type)).toBe("file");
  });
});

// 6. ref/ selectors scoped to an element work across open shadow roots
test("elementHandle.$('ref/eN') finds refs inside an open shadow root of a descendant", async () => {
  await withPage(async (page) => {
    await page.setContent(`<section id="wrap"><div id="host"></div></section><div id="other"><button>Outside</button></div>`);
    await page.evaluate(() => {
      const root = document.getElementById("host")!.attachShadow({ mode: "open" });
      root.innerHTML = `<button id="sb">Open shadow btn</button>`;
    });
    const y = (await page.snapshot()) as string;
    const ref = /- button "Open shadow btn" \[ref=(e\d+)\]/.exec(y)![1]!;
    const sel = `ref/${ref}`;
    expect(await page.$(sel)).not.toBeNull();
    const wrap = (await page.$("#wrap"))!;
    const h = await wrap.$(sel);
    expect(h).not.toBeNull();
    expect(await h!.evaluate((e) => e.id)).toBe("sb");
    expect((await wrap.$$(sel)).length).toBe(1);
    expect(await wrap.$eval(sel, (e) => e.textContent)).toBe("Open shadow btn");
    // still scoped: an unrelated element does not contain it
    const other = (await page.$("#other"))!;
    expect(await other.$(sel)).toBeNull();
    expect((await other.$$(sel)).length).toBe(0);
    // the host itself and its shadow root both contain it
    const host = (await page.$("#host"))!;
    expect(await host.$(sel)).not.toBeNull();
  });
});
