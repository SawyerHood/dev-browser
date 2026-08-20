/**
 * Snapshot quality fixes: accessible names from wrapped content, stable frame keys,
 * main-viewport boxes inside iframes, interactive-mode feedback text, generic refs
 * under pointer ancestors, contenteditable values, diff context / substantial change,
 * tailored truncation hint, depth markers, urls:false.
 */
import { test, expect, afterAll, beforeAll } from "bun:test";
import { withPage, closeBrowser } from "./helpers/browser.ts";
import { startServer, type FixtureServer } from "./helpers/server.ts";
import { getSnapshotState, diffLines, SUBSTANTIAL_CHANGE_NOTE } from "../src/page/snapshot/snapshot.ts";

const CHILD = `<!doctype html><body style="margin:0"><button id="inner" style="position:absolute;left:20px;top:50px;width:84px;height:21px">Frame btn</button></body>`;
const CHILD2 = `<!doctype html><body style="margin:0"><a href="/z" id="l2">second frame</a></body>`;
const GRANDCHILD = `<!doctype html><body style="margin:0"><button id="deep" style="position:absolute;left:5px;top:7px">Deep</button></body>`;
const MID = `<!doctype html><body style="margin:0"><iframe id="g" src="/grandchild" style="position:absolute;left:30px;top:40px;border:0"></iframe></body>`;

let srv: FixtureServer;

beforeAll(async () => {
  srv = await startServer({
    "/child": CHILD,
    "/child2": CHILD2,
    "/grandchild": GRANDCHILD,
    "/mid": MID,
    "/two": `<!doctype html><body style="margin:0"><h1>Two frames</h1><iframe id="a" src="/child"></iframe><iframe id="b" src="/child2"></iframe></body>`,
    "/boxed": `<!doctype html><body style="margin:0"><div style="height:350px"></div><iframe id="f" src="/child" style="margin-left:100px;border:10px solid red;width:400px;height:200px"></iframe></body>`,
    "/nested": `<!doctype html><body style="margin:0"><iframe id="m" src="/mid" style="position:absolute;left:100px;top:200px;border:3px solid blue;width:400px;height:300px"></iframe></body>`,
    "/long": `<ul>${Array.from({ length: 300 }, (_, i) => `<li><a href="/i/${i}">Item number ${i} with some text</a></li>`).join("")}</ul>`,
    "/a": `<h1>Page A</h1><p>text a</p><a href="/b">to b</a>`,
    "/b": `<h1>Page B</h1><ul>${Array.from({ length: 20 }, (_, i) => `<li><button>B ${i}</button></li>`).join("")}</ul>`,
  });
});

afterAll(async () => {
  await closeBrowser();
  await srv?.stop();
});

async function framesReady(page: import("./helpers/browser.ts").DoobiePage, n: number) {
  await page.waitForFunction(
    (n) => [...document.querySelectorAll("iframe")].filter((f) => f.contentDocument?.readyState === "complete" && f.contentDocument.body?.children.length).length >= n,
    {},
    n,
  );
}

// 1. accessible names from wrapped content
test("name-from-content recurses into wrapping descendants (span/b/div/img/labelledby)", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <button id="b"><span>Save</span></button>
      <a href="/docs"><b>Docs</b> <span>(new)</span></a>
      <h1><span>Title</span></h1>
      <table><tr><td><div>cell</div></td></tr></table>
      <div id="l1">First</div><div id="l2">Second</div><button aria-labelledby="l1 l2"></button>
      <button><img alt="Upload icon"></button>
      <div role="tab"><span>Tab one</span></div>
      <ul role="menu"><li role="menuitem"><span><em>Edit</em> item</span></li></ul>
      <div id="l3">Qty <input value="3"> <select><option>A</option><option selected>B</option></select></div><button aria-labelledby="l3">go</button>
      <label>Own <input id="own" value="ignored"></label>
    `);
    const y = (await page.snapshot()) as string;
    expect(y).toMatch(/- button "Save" \[ref=e\d+\]$/m);
    expect(y).toMatch(/- link "Docs \(new\)" \[ref=e\d+\] \[cursor=pointer\]:\n\s+- \/url: \/docs/);
    expect(y).toMatch(/- heading "Title" \[level=1\]/);
    expect(y).toMatch(/- cell "cell"/);
    expect(y).toMatch(/- button "First Second"/);
    expect(y).toMatch(/- button "Upload icon"/);
    expect(y).toMatch(/- tab "Tab one"/);
    expect(y).toMatch(/- menuitem "Edit item"/);
    // embedded controls inside a labelledby target contribute their value (accname 2E)...
    expect(y).toMatch(/- button "Qty 3 B"/);
    // ...but an input's own value is not part of its own label-derived name
    expect(y).toMatch(/- textbox "Own" \[ref=e\d+\]: ignored/);
    // the span inside the button is inlined, not a separate ref'd generic
    expect(y).not.toMatch(/button "Save"[^\n]*:\n\s+- generic/);
  });
});

// 5. generics under a pointer ancestor
test("inline spans under a link/pointer ancestor do not become ref'd generic lines", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <a href="/x"><span>openrouter.ai</span></a>
      <div id="card" style="cursor:pointer"><span>Label</span><div>Block</div><span style="cursor:pointer" onclick="1">own</span><span tabindex="0">tab</span></div>
      <div><span style="cursor:pointer">lonely pointer</span></div>
    `);
    const y = (await page.snapshot()) as string;
    // single link line with inlined text, no generic child line
    expect(y).toMatch(/- link "openrouter.ai" \[ref=e\d+\] \[cursor=pointer\]:\n\s+- \/url: \/x\n/);
    expect(y).not.toMatch(/- generic[^\n]*: openrouter.ai/);
    // the outermost pointer element carries the ref and [cursor=pointer]
    expect(y).toMatch(/- generic \[ref=e\d+\] \[cursor=pointer\]:\n\s+- text: Label\n\s+- generic: Block\n\s+- generic \[ref=e\d+\]: own\n\s+- generic \[ref=e\d+\]: tab/);
    // a span whose pointer cursor is its own (parent is not pointer) keeps its ref
    expect(y).toMatch(/- generic \[ref=e\d+\] \[cursor=pointer\]: lonely pointer/);
    // interactive mode: link is a single line with url; the card's non-clickable parts are not "interactive"
    const i = (await page.snapshot({ interactive: true })) as string;
    expect(i).toMatch(/- link "openrouter.ai" \[ref=e\d+\] \[cursor=pointer\]:\n\s+- \/url: \/x/);
    expect(i).not.toMatch(/- generic: Block/);
    expect(i).toMatch(/- generic \[ref=e\d+\]: own/);
  });
});

// 6. contenteditable textbox
test("contenteditable role=textbox shows its text as the value", async () => {
  await withPage(async (page) => {
    await page.setContent(`<label for="ed">Notes</label><div id="ed" role="textbox" contenteditable="true" aria-labelledby="lbl"><p>Likes <b>walks</b></p><p>and naps</p></div><span id="lbl">Notes</span>`);
    const y = (await page.snapshot()) as string;
    expect(y).toMatch(/- textbox "Notes" \[ref=e\d+\]: Likes walks and naps/);
    // DOM children of the editor are not rendered as separate paragraph nodes
    expect(y).not.toMatch(/textbox "Notes"[^\n]*:\n\s+- paragraph/);
    await page.$eval("#ed", (e) => ((e as HTMLElement).innerText = "Changed"));
    const y2 = (await page.snapshot({ interactive: true })) as string;
    expect(y2).toMatch(/- textbox "Notes" \[ref=e\d+\]: Changed/);
    // an empty editor shows no value
    await page.$eval("#ed", (e) => ((e as HTMLElement).innerText = ""));
    expect((await page.snapshot()) as string).toMatch(/- textbox "Notes" \[ref=e\d+\]$/m);
  });
});

// 4. interactive mode keeps feedback text
test("interactive mode keeps alerts, live regions, status and dialog body text", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <p>boring intro</p>
      <div role="alert">Wrong password</div>
      <div role="status">Saved 3 items</div>
      <output>42</output>
      <div aria-live="polite"><span>Loading done</span></div>
      <div role="log">line 1</div>
      <div role="tooltip">Hint text</div>
      <div role="dialog" aria-label="Confirm"><h2>Delete?</h2><p>Are you sure you want to delete?</p>Extra<button>Yes</button><button>No</button></div>
      <div role="alertdialog"><p>Session expired</p><button>OK</button></div>
    `);
    const i = (await page.snapshot({ interactive: true })) as string;
    expect(i).not.toContain("boring intro");
    expect(i).toMatch(/- alert \[ref=e\d+\]: Wrong password/);
    expect(i).toMatch(/- status \[ref=e\d+\]: Saved 3 items/);
    expect(i).toMatch(/- status \[ref=e\d+\]: "42"/);
    expect(i).toMatch(/- generic \[ref=e\d+\]: Loading done/);
    expect(i).toMatch(/- log \[ref=e\d+\]: line 1/);
    expect(i).toMatch(/- tooltip "Hint text" \[ref=e\d+\]/);
    expect(i).toMatch(/- dialog "Confirm" \[ref=e\d+\]:\n\s+- heading "Delete\?" \[level=2\] \[ref=e\d+\]\n\s+- paragraph \[ref=e\d+\]: Are you sure you want to delete\?\n\s+- text: Extra\n\s+- button "Yes"/);
    expect(i).toMatch(/- alertdialog \[ref=e\d+\]:\n\s+- paragraph \[ref=e\d+\]: Session expired/);
  });
});

// 2. stable frame keys
test("frame keys stay stable per frame across snapshots; removed frames free no keys", async () => {
  await withPage(async (page) => {
    await page.goto(srv.url("/two"));
    await framesReady(page, 2);
    const y1 = (await page.snapshot()) as string;
    expect(y1).toMatch(/- button "Frame btn" \[ref=f1e\d+\]/);
    const keyOfB = /- link "second frame" \[ref=(f\d+)e\d+\]/.exec(y1)![1]!;
    expect(keyOfB).toBe("f2");
    const refB = /- link "second frame" \[ref=(f\d+e\d+)\]/.exec(y1)![1]!;
    // scoped snapshot of the main document: frame keys untouched
    const s = (await page.snapshot({ scope: "#b" })) as string;
    expect(s).toMatch(/\[ref=f2e\d+\]/);
    // remove the first iframe; the remaining frame keeps f2 and the old ref still resolves to the same element
    await page.$eval("#a", (e) => e.remove());
    const y2 = (await page.snapshot()) as string;
    expect(y2).not.toContain("Frame btn");
    expect(y2).toMatch(/- link "second frame" \[ref=f2e\d+\]/);
    expect(y2).not.toMatch(/\[ref=f1e\d+\]/);
    const h = await page.ref(refB);
    expect(await h.evaluate((e) => e.id)).toBe("l2");
    const state = getSnapshotState(page);
    expect(state.frames.has("f1")).toBe(false); // detached frames are pruned
    expect(state.frames.has("f2")).toBe(true);
    // a new iframe inserted BEFORE the existing one gets a fresh key (f3), never f1
    await page.evaluate((src) => {
      const f = document.createElement("iframe");
      f.id = "c";
      f.src = src;
      document.body.insertBefore(f, document.querySelector("#b"));
    }, srv.url("/child"));
    await framesReady(page, 2);
    const y3 = (await page.snapshot()) as string;
    expect(y3).toMatch(/- button "Frame btn" \[ref=f3e\d+\]/);
    expect(y3).toMatch(/- link "second frame" \[ref=f2e\d+\]/);
    expect(state.frames.has("f1")).toBe(false);
    // a scoped snapshot inside f2 still works and keeps keys
    const scoped = (await page.snapshot({ scope: refB })) as string;
    expect(scoped).toMatch(/^- link "second frame" \[ref=f2e\d+\]/);
  });
});

// 3. boxes in iframes are main-viewport
test("[box=...] inside iframes is main-viewport relative (nested too)", async () => {
  await withPage(async (page) => {
    await page.goto(srv.url("/boxed"));
    await framesReady(page, 1);
    const y = (await page.snapshot({ boxes: true })) as string;
    const m = /- button "Frame btn" \[ref=f1e\d+\] \[box=(-?\d+),(-?\d+),(\d+),(\d+)\]/.exec(y);
    expect(m).not.toBeNull();
    const expected = await page.evaluate(() => {
      const f = document.querySelector("#f") as HTMLIFrameElement;
      const fr = f.getBoundingClientRect();
      const b = f.contentDocument!.querySelector("#inner")!.getBoundingClientRect();
      return [Math.round(fr.left + f.clientLeft + b.left), Math.round(fr.top + f.clientTop + b.top), Math.round(b.width), Math.round(b.height)];
    });
    expect([Number(m![1]), Number(m![2]), Number(m![3]), Number(m![4])]).toEqual(expected);
    expect(expected[1]!).toBeGreaterThan(350 + 10 + 50 - 1);
    // matches what Puppeteer reports for the same element (page coordinates)
    const ref = /- button "Frame btn" \[ref=(f1e\d+)\]/.exec(y)![1]!;
    const bb = await (await page.ref(ref)).boundingBox();
    expect(Math.round(bb!.x)).toBe(expected[0]!);
    expect(Math.round(bb!.y)).toBe(expected[1]!);
    // scoped into the frame with boxes: still main-viewport
    const s = (await page.snapshot({ scope: ref, boxes: true })) as string;
    const ms = /\[box=(-?\d+),(-?\d+),/.exec(s)!;
    expect([Number(ms[1]), Number(ms[2])]).toEqual([expected[0]!, expected[1]!]);

    // two levels deep
    await page.goto(srv.url("/nested"));
    await page.waitForFunction(() => {
      const m = document.querySelector("#m") as HTMLIFrameElement;
      const g = m.contentDocument?.querySelector("#g") as HTMLIFrameElement | null;
      return !!g?.contentDocument?.querySelector("#deep");
    });
    const y2 = (await page.snapshot({ boxes: true })) as string;
    const d = /- button "Deep" \[ref=f\d+e\d+\] \[box=(-?\d+),(-?\d+),/.exec(y2);
    expect(d).not.toBeNull();
    const exp2 = await page.evaluate(() => {
      const m = document.querySelector("#m") as HTMLIFrameElement;
      const g = m.contentDocument!.querySelector("#g") as HTMLIFrameElement;
      const b = g.contentDocument!.querySelector("#deep")!.getBoundingClientRect();
      const mr = m.getBoundingClientRect();
      const gr = g.getBoundingClientRect();
      return [Math.round(mr.left + m.clientLeft + gr.left + g.clientLeft + b.left), Math.round(mr.top + m.clientTop + gr.top + g.clientTop + b.top)];
    });
    expect([Number(d![1]), Number(d![2])]).toEqual(exp2);
  });
});

// 7. tracked diffs: context, substantial change
test("tracked incremental: first = full, context lines per hunk, full on substantial change", async () => {
  await withPage(async (page) => {
    await page.goto(srv.url("/a"));
    const first = (await page.snapshot({ track: "t" })) as { full: string; incremental: string };
    expect(first.incremental).toBe(first.full);
    await page.evaluate(() => {
      const b = document.createElement("button");
      b.textContent = "Added";
      document.body.appendChild(b);
    });
    const second = (await page.snapshot({ track: "t" })) as { full: string; incremental: string };
    const lines = second.incremental.split("\n");
    // first line is unchanged context (the previous sibling / parent), then the insertion
    expect(lines[0]).toMatch(/^  /);
    expect(lines.some((l) => l.startsWith('+ ') && l.includes('button "Added"'))).toBe(true);
    expect(lines.every((l) => /^(\+ |- |  )/.test(l) || l === "…")).toBe(true);
    // navigation: the diff would be bigger than the page; full snapshot with a note instead
    await page.goto(srv.url("/b"));
    const third = (await page.snapshot({ track: "t" })) as { full: string; incremental: string };
    expect(third.incremental.startsWith(SUBSTANTIAL_CHANGE_NOTE + "\n")).toBe(true);
    expect(third.incremental.slice(SUBSTANTIAL_CHANGE_NOTE.length + 1)).toBe(third.full);
    expect(third.incremental.length).toBeLessThanOrEqual(third.full.length + SUBSTANTIAL_CHANGE_NOTE.length + 1);
    // small change on the new page: back to a diff
    await page.evaluate(() => (document.querySelector("button")!.textContent = "B zero"));
    const fourth = (await page.snapshot({ track: "t" })) as { full: string; incremental: string };
    expect(fourth.incremental).not.toContain(SUBSTANTIAL_CHANGE_NOTE);
    expect(fourth.incremental).toMatch(/- [^\n]*button "B 0"/);
    expect(fourth.incremental).toMatch(/\+ [^\n]*button "B zero"/);
    expect(fourth.incremental.length).toBeLessThan(fourth.full.length);
  });
});

test("diffLines: context line before each hunk and … between hunks", () => {
  expect(diffLines(["p", "a", "b", "c", "d", "e"], ["p", "a", "X", "c", "d", "Y", "e"])).toBe("  a\n- b\n+ X\n…\n  d\n+ Y");
  // change at the very start has no context line
  expect(diffLines(["a", "b"], ["x", "b"])).toBe("- a\n+ x");
  // pure append gets the last line as context
  expect(diffLines(["a", "b"], ["a", "b", "c"])).toBe("  b\n+ c");
});

// 8. truncation hint + depth marker
test("truncation hint is tailored to the mode; depth-cut nodes carry a […] marker", async () => {
  await withPage(async (page) => {
    await page.goto(srv.url("/long"));
    const plain = (await page.snapshot({ maxChars: 1000 })) as string;
    expect(plain).toMatch(/# \.\.\. truncated at 1000 chars \(\d+ more lines\)\. Narrow with snapshot\(\{ scope: 'eN' \}\) or snapshot\(\{ interactive: true \}\)\.$/);
    const inter = (await page.snapshot({ maxChars: 1000, interactive: true })) as string;
    const last = inter.split("\n").pop()!;
    expect(last).toMatch(/^# \.\.\. truncated at 1000 chars/);
    expect(last).not.toContain("interactive: true");
    expect(last).toContain("scope: 'eN'");
    expect(last).toContain("urls: false");
    expect(last).toContain("maxChars");
    const inter2 = (await page.snapshot({ maxChars: 1000, interactive: true, urls: false, depth: 3 })) as string;
    const last2 = inter2.split("\n").pop()!;
    expect(last2).not.toContain("urls: false");
    expect(last2).not.toContain("depth");

    await page.setContent(`<nav><ul><li><a href="/a">A</a></li></ul></nav><section aria-label="s"><p>x</p></section><h1>Leaf</h1>`);
    const d2 = (await page.snapshot({ depth: 2 })) as string;
    expect(d2).toMatch(/- navigation \[ref=e\d+\] \[…\]$/m);
    expect(d2).toMatch(/- region "s" \[ref=e\d+\] \[…\]$/m);
    // real leaves at the depth limit carry no marker
    expect(d2).toMatch(/- heading "Leaf" \[level=1\] \[ref=e\d+\]$/m);
    const full = (await page.snapshot()) as string;
    expect(full).not.toContain("[…]");
  });
});

// 9. urls: false
test("urls: false drops the /url lines", async () => {
  await withPage(async (page) => {
    await page.setContent(`<a href="/one">One</a><a href="/two"><span>Two</span><b>!</b></a><button>B</button>`);
    const withUrls = (await page.snapshot()) as string;
    expect(withUrls).toContain("- /url: /one");
    const noUrls = (await page.snapshot({ urls: false })) as string;
    expect(noUrls).not.toContain("/url");
    expect(noUrls).toMatch(/- link "One" \[ref=e\d+\] \[cursor=pointer\]$/m);
    expect(noUrls).toMatch(/- link "Two!" \[ref=e\d+\] \[cursor=pointer\]$/m);
    expect(noUrls.length).toBeLessThan(withUrls.length);
    const inter = (await page.snapshot({ interactive: true, urls: false })) as string;
    expect(inter).not.toContain("/url");
    expect(inter).toMatch(/- button "B"/);
  });
});
