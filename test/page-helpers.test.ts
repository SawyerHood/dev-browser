/**
 * Page helper behaviour against real headless Chrome (no daemon):
 * background-tab input, shot() DPR math, fill() on non-text inputs,
 * stale-ref errors, default dialog handling, and the per-run gate.
 */
import { test, expect, describe, afterAll, beforeAll } from "bun:test";
import * as fs from "node:fs";
import { getBrowser, newPage, withPage, closeBrowser } from "./helpers/browser.ts";
import { ensureFront, resetFront } from "../src/page/extend.ts";
import { readDims } from "../src/page/shot.ts";
import { RunGate, RunAbortedError, tame, renderResult, formatConsoleArgs } from "../src/daemon/run.ts";
import { addPageLineHook } from "../src/daemon/run-context.ts";
import { startServer, type FixtureServer, sleep } from "./helpers/server.ts";
import * as vm from "node:vm";

let srv: FixtureServer;
beforeAll(async () => {
  srv = await startServer({
    "/btn": "<!doctype html><title>Btn</title><button id=b onclick=\"window.clicked=(window.clicked||0)+1\">go</button>",
    "/tall": "<!doctype html><style>body{margin:0;height:3000px}</style><p>tall</p>",
    "/forms": `<!doctype html><title>Forms</title>
      <input id=text value=old>
      <input id=date type=date value=2020-02-02>
      <input id=time type=time>
      <input id=num type=number value=1>
      <input id=color type=color>
      <input id=range type=range min=0 max=100 value=10>
      <input id=ro value=ro readonly>
      <input id=dis value=dis disabled>
      <input id=cb type=checkbox>
      <select id=sel><option>a</option><option>b</option></select>
      <textarea id=ta>x</textarea>
      <div id=ce contenteditable>old text</div>`,
    "/dialogs": `<!doctype html><title>Dialogs</title>
      <button id=alert onclick="alert('hello there'); window.afterAlert = true">a</button>
      <button id=confirm onclick="window.answer = confirm('sure?')">c</button>`,
  });
});
afterAll(async () => {
  await srv.stop();
  await closeBrowser();
});

describe("background tabs", () => {
  test("click and shot on a page that is not the front tab do not hang", async () => {
    const a = await newPage();
    const b = await newPage();
    try {
      await a.goto(srv.url("/btn"));
      await b.goto(srv.url("/btn"));
      await b.bringToFront(); // b is the front tab; a is hidden
      await sleep(800); // let Chrome throttle the background renderer
      expect(await a.evaluate(() => document.visibilityState)).toBe("hidden");
      const t0 = Date.now();
      await a.click("#b");
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(await a.evaluate(() => (window as unknown as { clicked: number }).clicked)).toBe(1);
      expect(await a.evaluate(() => document.visibilityState)).toBe("visible");
      // now b is hidden: mouse.* and shot on b must work too
      await sleep(800);
      const t1 = Date.now();
      await b.mouse.click(5, 5);
      const s = await b.shot();
      expect(Date.now() - t1).toBeLessThan(3000);
      expect(s.width).toBe(1280);
      // switching back to a: ElementHandle.click goes through page.mouse as well
      await sleep(800);
      const h = await a.$("#b");
      await h!.click();
      expect(await a.evaluate(() => (window as unknown as { clicked: number }).clicked)).toBe(2);
    } finally {
      await a.close().catch(() => {});
      await b.close().catch(() => {});
    }
  }, 20_000);

  test("ensureFront is a no-op (microseconds) when the page is already in front", async () => {
    await withPage(async (page) => {
      await page.goto(srv.url("/btn"));
      resetFront(await getBrowser());
      await ensureFront(page);
      const t0 = performance.now();
      for (let i = 0; i < 200; i++) await ensureFront(page);
      const per = (performance.now() - t0) / 200;
      expect(per).toBeLessThan(0.1);
    });
  });
});

describe("page.shot() math", () => {
  test("viewport shot at DPR 2 is 1:1 CSS pixels with scale 1", async () => {
    await withPage(async (page) => {
      await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });
      await page.goto(srv.url("/tall"));
      const s = await page.shot();
      expect([s.width, s.height, s.scale]).toEqual([800, 600, 1]);
      expect(readDims(s.path, "jpeg")).toEqual({ width: 800, height: 600 });
      expect(Object.keys(s).sort()).toEqual(["height", "path", "scale", "width"]);
    });
  });

  test("viewport shot at DPR 1 and maxEdge downscale", async () => {
    await withPage(async (page) => {
      await page.goto(srv.url("/tall"));
      const s = await page.shot();
      expect([s.width, s.height, s.scale]).toEqual([1280, 720, 1]);
      const small = await page.shot({ maxEdge: 640 });
      expect([small.width, small.height, small.scale]).toEqual([640, 360, 0.5]);
    });
  });

  test("fullPage and clip shots at DPR 2: size = CSS size * scale, scale = min(1, maxEdge/longest)", async () => {
    await withPage(async (page) => {
      await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });
      await page.goto(srv.url("/tall"));
      const sh = await page.evaluate(() => document.documentElement.scrollHeight);
      const full = await page.shot({ fullPage: true });
      const fit = 1568 / sh;
      expect(full.height).toBe(1568);
      expect(full.width).toBe(Math.round(800 * fit));
      expect(Math.abs(full.scale - fit)).toBeLessThan(0.001);
      const clip = await page.shot({ clip: { x: 10, y: 20, width: 300, height: 200 } });
      expect([clip.width, clip.height, clip.scale]).toEqual([300, 200, 1]);
      const clipBig = await page.shot({ clip: { x: 0, y: 0, width: 400, height: 2000 }, maxEdge: 1000 });
      expect([clipBig.width, clipBig.height, clipBig.scale]).toEqual([200, 1000, 0.5]);
    });
  });

  test("type follows the name extension; png gets png bytes", async () => {
    await withPage(async (page) => {
      await page.goto(srv.url("/btn"));
      const png = await page.shot({ name: `t-${Date.now()}.png` });
      expect(png.path.endsWith(".png")).toBe(true);
      expect([...fs.readFileSync(png.path).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      const jpg = await page.shot({ name: `t-${Date.now()}-b` });
      expect(jpg.path.endsWith("-b.jpg")).toBe(true);
      expect([...fs.readFileSync(jpg.path).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      const mismatch = await page.shot({ name: `t-${Date.now()}-c.png`, type: "jpeg" });
      expect(mismatch.path.endsWith(".png.jpg")).toBe(true);
    });
  });
});

describe("page.fill()", () => {
  test("date/time/number/color/range take the value verbatim; text-like inputs are typed", async () => {
    await withPage(async (page) => {
      await page.goto(srv.url("/forms"));
      await page.fill("#date", "2024-01-15");
      await page.fill("#time", "13:45");
      await page.fill("#num", "12.5");
      await page.fill("#color", "#ff0000");
      await page.fill("#range", "42");
      await page.fill("#text", "typed");
      await page.fill("#ta", "area");
      await page.fill("#ce", "rich");
      const v = await page.evaluate(() => ({
        date: (document.querySelector("#date") as HTMLInputElement).value,
        time: (document.querySelector("#time") as HTMLInputElement).value,
        num: (document.querySelector("#num") as HTMLInputElement).value,
        color: (document.querySelector("#color") as HTMLInputElement).value,
        range: (document.querySelector("#range") as HTMLInputElement).value,
        text: (document.querySelector("#text") as HTMLInputElement).value,
        ta: (document.querySelector("#ta") as HTMLTextAreaElement).value,
        ce: (document.querySelector("#ce") as HTMLElement).textContent,
      }));
      expect(v).toEqual({ date: "2024-01-15", time: "13:45", num: "12.5", color: "#ff0000", range: "42", text: "typed", ta: "area", ce: "rich" });
    });
  });

  test("readonly/disabled/checkbox/select throw and keep their value; events fire for value-set inputs", async () => {
    await withPage(async (page) => {
      await page.goto(srv.url("/forms"));
      await page.evaluate(() => {
        (window as unknown as { ev: string[] }).ev = [];
        const d = document.querySelector("#date")!;
        d.addEventListener("input", () => (window as unknown as { ev: string[] }).ev.push("input"));
        d.addEventListener("change", () => (window as unknown as { ev: string[] }).ev.push("change"));
      });
      await expect(page.fill("#ro", "x")).rejects.toThrow(/readonly/);
      await expect(page.fill("#dis", "x")).rejects.toThrow(/disabled/);
      await expect(page.fill("#cb", "x")).rejects.toThrow(/checkbox/);
      await expect(page.fill("#sel", "b")).rejects.toThrow(/page\.select/);
      await expect(page.fill("#date", "nope")).rejects.toThrow(/rejected "nope"/);
      await page.fill("#date", "2024-03-03");
      const v = await page.evaluate(() => ({
        ro: (document.querySelector("#ro") as HTMLInputElement).value,
        dis: (document.querySelector("#dis") as HTMLInputElement).value,
        ev: (window as unknown as { ev: string[] }).ev,
      }));
      expect(v.ro).toBe("ro");
      expect(v.dis).toBe("dis");
      expect(v.ev).toEqual(["input", "change"]);
    });
  });
});

describe("ref selectors", () => {
  test("stale/unknown ref via selector APIs gives the documented message with the original as cause", async () => {
    await withPage(async (page) => {
      await page.goto(srv.url("/btn"));
      await page.snapshot();
      for (const call of [
        () => page.click("ref/e999"),
        () => page.type("ref/e999", "x"),
        () => page.hover("ref/e999"),
        () => page.fill("ref/e999", "x"),
        () => page.$eval("ref/e999", (e) => e.tagName),
      ]) {
        let err: Error | undefined;
        await call().catch((e: Error) => (err = e));
        expect(err).toBeDefined();
        expect(err!.message).toBe('Ref "e999" is stale or unknown. Take a new page.snapshot() and use a fresh ref.');
        expect(err!.cause).toBeDefined();
      }
      // frame-prefixed refs with an unknown frame reject (never throw synchronously)
      let caught: unknown;
      const p = page.click("ref/f9e1").catch((e: unknown) => (caught = e));
      expect(p).toBeInstanceOf(Promise);
      await p;
      expect(String((caught as Error).message)).toMatch(/Frame f9/);
      let caught2: unknown;
      await page.fill("ref/f9e1", "x").catch((e: unknown) => (caught2 = e));
      expect(String((caught2 as Error).message)).toMatch(/Frame f9/);
      // $ on a missing ref is null, not an error (Puppeteer semantics)
      expect(await page.$("ref/e999")).toBeNull();
    });
  });
});

describe("dialogs", () => {
  test("an unhandled alert is auto-dismissed and reported; click does not hang", async () => {
    await withPage(async (page) => {
      await page.goto(srv.url("/dialogs"));
      const lines: string[] = [];
      const off = addPageLineHook(page, (t) => lines.push(t));
      const t0 = Date.now();
      await page.click("#alert");
      expect(Date.now() - t0).toBeLessThan(4000);
      await sleep(50);
      expect(await page.evaluate(() => (window as unknown as { afterAlert: boolean }).afterAlert)).toBe(true);
      expect(lines).toEqual(["dialog alert: hello there (auto-dismissed)"]);
      await page.click("#confirm");
      await sleep(50);
      expect(await page.evaluate(() => (window as unknown as { answer: boolean }).answer)).toBe(false);
      expect(lines[1]).toBe("dialog confirm: sure? (auto-dismissed)");
      off();
      // page still usable afterwards
      expect(await page.title()).toBe("Dialogs");
    });
  });

  test("a script's own dialog listener keeps control", async () => {
    await withPage(async (page) => {
      await page.goto(srv.url("/dialogs"));
      const lines: string[] = [];
      const off = addPageLineHook(page, (t) => lines.push(t));
      const onDialog = (d: { accept(): Promise<void> }) => void d.accept();
      page.on("dialog", onDialog);
      await page.click("#confirm");
      await sleep(50);
      expect(await page.evaluate(() => (window as unknown as { answer: boolean }).answer)).toBe(true);
      expect(lines).toEqual([]);
      page.off("dialog", onDialog);
      off();
    });
  });
});

describe("run gate", () => {
  test("guarded page: calls work, then throw RunAbortedError after close; listeners and timers are cleaned up", async () => {
    await withPage(async (page) => {
      await page.goto(srv.url("/btn"));
      const gate = new RunGate();
      const g = gate.guard(page, "page");
      expect(gate.guard(page, "page")).toBe(g);
      expect(await g.title()).toBe("Btn");
      expect(g.url()).toBe(srv.url("/btn"));
      // in-flight description while a call is pending
      const pending = g.evaluate(() => new Promise((r) => setTimeout(r, 200)));
      expect(gate.lastInflight()).toBe("page.evaluate()");
      await pending;
      expect(gate.lastInflight()).toBeUndefined();
      const clickP = g.click("#b");
      expect(gate.lastInflight()).toBe('page.click("#b")');
      await clickP;
      // mouse/keyboard through the guard
      const m = g.mouse.click(3, 3);
      expect(gate.lastInflight()).toBe("page.mouse.click(3, 3)");
      await m;
      // listeners registered through the guard are removed at close
      const before = page.listenerCount("console");
      const beforeDialog = page.listenerCount("dialog");
      const fn = () => {};
      g.on("console", fn);
      g.once("dialog", fn);
      const beforeReq = page.listenerCount("request");
      g.once("request", fn);
      expect(page.listenerCount("request")).toBe(beforeReq + 1);
      g.off("request", fn); // off() with the original handler removes a once() registration too
      expect(page.listenerCount("request")).toBe(beforeReq);
      expect(page.listenerCount("console")).toBe(before + 1);
      expect(page.listenerCount("dialog")).toBe(beforeDialog + 1);
      // timers created through the sandbox globals are cleared at close
      const tg = gate.timerGlobals() as { setTimeout: typeof setTimeout; setInterval: typeof setInterval; clearTimeout: typeof clearTimeout };
      let fired = 0;
      tg.setTimeout(() => fired++, 50);
      tg.setInterval(() => fired++, 20);
      const cleared = tg.setTimeout(() => fired++, 10);
      tg.clearTimeout(cleared);
      gate.close("deadline passed");
      await sleep(120);
      expect(fired).toBe(0);
      expect(page.listenerCount("console")).toBe(before);
      expect(page.listenerCount("dialog")).toBe(beforeDialog);
      // every call now rejects (asynchronously, so a retry loop cannot starve the event loop)
      await expect(g.url() as unknown as Promise<unknown>).rejects.toThrow(RunAbortedError);
      let err: unknown;
      try {
        await g.evaluate(() => 1);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RunAbortedError);
      expect((err as Error).message).toBe("script deadline passed");
      await expect(g.mouse.click(1, 1)).rejects.toThrow(RunAbortedError);
      // the raw page is unaffected
      expect(await page.title()).toBe("Btn");
    });
  });

  test("per-call overhead of the guard is small", async () => {
    await withPage(async (page) => {
      const gate = new RunGate();
      const g = gate.guard(page, "page");
      g.url();
      const N = 20_000;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) g.url();
      const guarded = (performance.now() - t0) / N;
      const t1 = performance.now();
      for (let i = 0; i < N; i++) page.url();
      const raw = (performance.now() - t1) / N;
      // budget: <= 0.1 ms per call over raw Puppeteer (design-decisions §8); typically ~1 µs
      expect(guarded - raw).toBeLessThan(0.1);
    });
  });
});

describe("result/console formatting of vm-realm values", () => {
  const ctx = vm.createContext({});
  const mk = (src: string) => vm.runInContext(src, ctx) as unknown;
  test("Error, Map, Set, typed arrays from the script realm", () => {
    expect(tame(mk("new TypeError('bad')"))).toBe("TypeError: bad");
    expect(formatConsoleArgs([mk("new TypeError('bad')")])).toBe("TypeError: bad");
    expect(renderResult(mk("new Map([['a', 1], ['b', { c: new Set([1, 2]) }]])"))).toEqual({
      text: '{\n  "a": 1,\n  "b": {\n    "c": [\n      1,\n      2\n    ]\n  }\n}',
      data: { a: 1, b: { c: [1, 2] } },
    });
    expect(renderResult(mk("new Uint8Array(3)"))).toEqual({ text: "<Buffer 3 bytes>", data: "<Buffer 3 bytes>" });
    expect(renderResult(mk("({ e: new RangeError('r'), n: 1n })"))).toEqual({ text: '{\n  "e": "RangeError: r",\n  "n": "1n"\n}', data: { e: "RangeError: r", n: "1n" } });
  });
  test("strings and primitives carry data; undefined has no result", () => {
    expect(renderResult("s")).toEqual({ text: "s", data: "s" });
    expect(renderResult(5)).toEqual({ text: "5", data: 5 });
    expect(renderResult(null)).toEqual({ text: "null", data: null });
    expect(renderResult(undefined)).toBeUndefined();
  });
});
