/**
 * End-to-end: script runtime guard rails through the real CLI + daemon +
 * headless Chrome. Background tabs, zombie scripts after deadline/disconnect,
 * listener/timer cleanup, timeout messages, dialogs, page-console hygiene,
 * result formatting, stale refs, trailing object literals.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { makeCliEnv, type CliEnv } from "../helpers/cli.ts";
import { startServer, sleep, type FixtureServer } from "../helpers/server.ts";

let cli: CliEnv;
let srv: FixtureServer;
const H = ["--headless"];
const q = (s: string) => JSON.stringify(s);

beforeAll(async () => {
  cli = makeCliEnv("doobie-e2e-rt2-");
  srv = await startServer({
    "/": "<!doctype html><title>Home</title><h1 id=t>hello</h1>",
    "/btn": "<!doctype html><title>Btn</title><button id=b onclick=\"window.clicked=(window.clicked||0)+1\">go</button>",
    "/dialogs": `<!doctype html><title>Dialogs</title>
      <button id=alert onclick="alert('hello'); window.afterAlert = true">a</button>
      <button id=confirm onclick="window.answer = confirm('sure?')">c</button>`,
    "/res": "<!doctype html><title>Res</title><script src='/missing.js'></script><p>x</p>",
    "/spam": "<!doctype html><script>for (let i = 0; i < 40; i++) console.error('spam ' + i)</script>",
    "/tick": "ok",
  });
  const r = await cli.run([...H, "-e", "1"]);
  expect(r.code).toBe(0);
});

afterAll(async () => {
  await srv.stop();
  await cli.cleanup();
});

describe("background tabs", () => {
  test("click/shot on a named page that is no longer the front tab completes", async () => {
    const script = `const a = await browser.getPage("bgA")
await a.goto(${q(srv.url("/btn"))})
const b = await browser.getPage("bgB")
await b.goto(${q(srv.url("/btn"))})
await b.bringToFront()
await new Promise(r => setTimeout(r, 700))
const t0 = Date.now()
await a.click("#b")
const h = await a.$("#b"); await h.click()
await a.mouse.click(2, 2)
const s = await a.shot()
const dt = Date.now() - t0
await new Promise(r => setTimeout(r, 700))
const t1 = Date.now()
await b.click("#b")
const dt2 = Date.now() - t1;
({ clicked: await a.evaluate(() => window.clicked), w: s.width, fast: dt < 3000 && dt2 < 3000 })`;
    const r = await cli.run([...H, "-t", "15"], { stdin: script });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const v = JSON.parse(r.stdout.split("\n").filter((l) => !l.startsWith("[image]")).join("\n"));
    expect(v).toEqual({ clicked: 2, w: 1280, fast: true });
  }, 30_000);
});

describe("zombie scripts", () => {
  test("after a deadline the script stops at its next page call and the page is free for the next script", async () => {
    const zombie = `const p = await browser.getPage("zombie")
await p.goto(${q(srv.url("/"))})
for (;;) { await p.evaluate(() => { document.title = "zombie" }) }`;
    const r = await cli.run([...H, "-t", "1"], { stdin: zombie });
    expect(r.code).toBe(124);
    expect(r.stderr.split("\n")[0]).toBe("TimeoutError: Timed out after 1s (deadline) while in page.evaluate()");
    const next = `const p = await browser.getPage("zombie")
await p.evaluate(() => { document.title = "mine" })
await new Promise(r => setTimeout(r, 700))
await p.title()`;
    const r2 = await cli.run([...H, "-t", "10"], { stdin: next });
    expect(r2.stderr).toBe("");
    expect(r2.stdout).toBe("mine\n");
    const st = await cli.run(["status"]);
    expect(st.stdout).toMatch(/runs\s+0 active|activeRuns.*0|0 active/);
  }, 30_000);

  test("a zombie that swallows errors and retries does not wedge the daemon", async () => {
    const zombie = `const p = await browser.getPage("zombie")
for (;;) { try { await p.evaluate(() => 1) } catch {} }`;
    const r = await cli.run([...H, "-t", "1"], { stdin: zombie });
    expect(r.code).toBe(124);
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const r2 = await cli.run([...H, "-e", "'alive'"]);
      expect(r2.stdout).toBe("alive\n");
      expect(Date.now() - t0).toBeLessThan(3000);
      await sleep(300);
    }
  }, 30_000);

  test("timeout message names the in-flight call with its selector; plain sleeps keep the old message", async () => {
    const script = `const p = await browser.getPage("zombie")
await p.waitForSelector("#never", { timeout: 10000 })`;
    const r = await cli.run([...H, "-t", "1"], { stdin: script });
    expect(r.code).toBe(124);
    expect(r.stderr.split("\n")[0]).toBe('TimeoutError: Timed out after 1s (deadline) while in page.waitForSelector("#never")');
    const r2 = await cli.run([...H, "-t", "1", "-e", "await new Promise(r => setTimeout(r, 3000))"]);
    expect(r2.code).toBe(124);
    expect(r2.stderr.split("\n")[0]).toBe("TimeoutError: Timed out after 1s (deadline)");
  }, 30_000);

  test("client disconnect ends the run: the script stops touching the page and status shows 0 active", async () => {
    const ghost = `const p = await browser.getPage("ghost")
await p.goto(${q(srv.url("/"))})
for (;;) { await p.evaluate(() => { document.title = "ghost" }) }`;
    // the helper kills the client after timeoutMs
    const r = await cli.run([...H, "-t", "20"], { stdin: ghost, timeoutMs: 1500 });
    expect(r.code).not.toBe(0);
    await sleep(300);
    const st = await cli.run(["status"]);
    expect(st.stdout).toMatch(/0 active/);
    const next = `const p = await browser.getPage("ghost")
await p.evaluate(() => { document.title = "mine" })
await new Promise(r => setTimeout(r, 700))
await p.title()`;
    const r2 = await cli.run([...H, "-t", "10"], { stdin: next });
    expect(r2.stdout).toBe("mine\n");
  }, 30_000);

  test("page listeners and timers from a finished script are removed", async () => {
    const counts = `const p = await browser.getPage("lst");
[p.listenerCount("console"), p.listenerCount("request"), p.listenerCount("dialog")]`;
    const base = await cli.run(H, { stdin: counts });
    expect(base.code).toBe(0);
    const baseline = JSON.parse(base.stdout) as number[];
    const first = `const p = await browser.getPage("lst")
await p.goto(${q(srv.url("/"))})
p.on("console", () => {})
p.once("request", () => {})
p.on("dialog", d => d.accept())
setInterval(() => { fetch(${q(srv.url("/tick"))}).catch(() => {}) }, 30)
setTimeout(() => { fetch(${q(srv.url("/tick"))}).catch(() => {}) }, 100000)
await new Promise(r => setTimeout(r, 200))
"first done"`;
    const r = await cli.run(H, { stdin: first });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("first done\n");
    await sleep(300);
    const ticks = srv.hits.filter((h) => h.endsWith("/tick")).length;
    expect(ticks).toBeGreaterThan(0);
    await sleep(400);
    expect(srv.hits.filter((h) => h.endsWith("/tick")).length).toBe(ticks);
    const r2 = await cli.run(H, { stdin: counts });
    expect(r2.code).toBe(0);
    // only doobie's own listeners remain (console collector, load tracker, default dialog handler)
    expect(JSON.parse(r2.stdout)).toEqual(baseline);
    expect(baseline[2]).toBe(1);
  }, 30_000);
});

describe("dialogs", () => {
  test("unhandled alert is auto-dismissed and reported on stderr; click does not hang", async () => {
    const script = `const p = await browser.getPage("dlg")
await p.goto(${q(srv.url("/dialogs"))})
await p.click("#alert")
await p.click("#confirm")
await new Promise(r => setTimeout(r, 50));
[await p.evaluate(() => window.afterAlert), await p.evaluate(() => window.answer)]`;
    const r = await cli.run([...H, "-t", "10"], { stdin: script });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([true, false]);
    expect(r.stderr).toContain("[page:dlg] dialog alert: hello (auto-dismissed)");
    expect(r.stderr).toContain("[page:dlg] dialog confirm: sure? (auto-dismissed)");
  }, 20_000);

  test("a script's own dialog handler keeps control", async () => {
    const script = `const p = await browser.getPage("dlg")
await p.goto(${q(srv.url("/dialogs"))})
p.on("dialog", d => d.accept())
await p.click("#confirm")
await new Promise(r => setTimeout(r, 50))
await p.evaluate(() => window.answer)`;
    const r = await cli.run([...H, "-t", "10"], { stdin: script });
    expect(r).toEqual({ code: 0, stdout: "true\n", stderr: "" });
  }, 20_000);
});

describe("page console hygiene", () => {
  test("favicon 404 is dropped; failed resources name their URL; overflow gets a marker", async () => {
    const script = `const p = await browser.getPage("res")
await p.goto(${q(srv.url("/res"))})
await new Promise(r => setTimeout(r, 300))
"ok"`;
    const r = await cli.run(H, { stdin: script });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`[page:res] error: Failed to load resource: the server responded with a status of 404 (Not Found) (${srv.url("/missing.js")})`);
    expect(r.stderr).not.toContain("favicon");
    const spam = `const p = await browser.getPage("spam2")
await p.goto(${q(srv.url("/spam"))})
await new Promise(r => setTimeout(r, 200))
"ok"`;
    const r2 = await cli.run(H, { stdin: spam });
    const lines = r2.stderr.split("\n").filter((l) => l.startsWith("[page"));
    expect(lines.length).toBe(21);
    expect(lines[20]).toBe("[page] ... 20 more lines");
  }, 20_000);
});

describe("result formatting", () => {
  test("vm-realm Error/Map/Set print usefully; console.log(err) shows the message", async () => {
    const r = await cli.run(H, { stdin: "try { null.x } catch (e) { console.log(e) }\nconst m = new Map([['a', new Set([1])]])\nm" });
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[0]).toMatch(/^TypeError: /);
    expect(r.stdout).toContain('{\n  "a": [\n    1\n  ]\n}');
    const r2 = await cli.run([...H, "-e", "new RangeError('bad range')"]);
    expect(r2.stdout).toBe("RangeError: bad range\n");
  });

  test("--json result frame carries structured data", async () => {
    const r = await cli.run([...H, "--json", "-e", "({ a: [1, 'x'], s: 'str' })"]);
    const frames = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    const res = frames.find((f) => f.type === "result");
    expect(res.data).toEqual({ a: [1, "x"], s: "str" });
    expect(typeof res.value).toBe("string");
    const r2 = await cli.run([...H, "--json", "-e", "'plain'"]);
    const res2 = r2.stdout.trim().split("\n").map((l) => JSON.parse(l)).find((f) => f.type === "result");
    expect(res2).toEqual({ type: "result", value: "plain", data: "plain" });
  });

  test("trailing object literal without parens is the result", async () => {
    const r = await cli.run([...H, "-e", "const t = 'x'\n{ t, n: 1 }"]);
    expect(r).toEqual({ code: 0, stdout: '{\n  "t": "x",\n  "n": 1\n}\n', stderr: "" });
  });

  test("page.shot() as the last expression prints one [image] line and a compact object", async () => {
    const script = `const p = await browser.getPage("shot2")
await p.goto(${q(srv.url("/"))})
await p.shot()`;
    const r = await cli.run(H, { stdin: script });
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n").filter((l) => l.startsWith("[image]")).length).toBe(1);
    const obj = JSON.parse(r.stdout.split("\n").filter((l) => !l.startsWith("[image]")).join("\n"));
    expect(Object.keys(obj).sort()).toEqual(["height", "path", "scale", "width"]);
  });
});

describe("errors", () => {
  test("per-action timeout shows the cause; stale ref via selector shows the documented message and a script frame", async () => {
    const script = `const p = await browser.getPage("err2")
await p.goto(${q(srv.url("/"))})
await p.waitForSelector("#never", { timeout: 300 })`;
    const r = await cli.run(H, { stdin: script });
    expect(r.code).toBe(1);
    expect(r.stderr.split("\n")[0]).toMatch(/Waiting for selector `#never` failed.*300ms exceeded/);
    const stale = `const p = await browser.getPage("err2")
await p.snapshot()
await p.click("ref/e999")`;
    const r2 = await cli.run(H, { stdin: stale });
    expect(r2.code).toBe(1);
    const lines = r2.stderr.split("\n");
    expect(lines[0]).toStartWith('Error: Ref "e999" is stale or unknown. Take a new page.snapshot() and use a fresh ref.');
    expect(lines[0]).toContain("(cause: No element found for selector: ref/e999)");
    expect(lines[1]).toMatch(/^    at <stdin>:3:\d+$/);
    // frame-ref errors reject (catchable), never throw synchronously
    const caught = `const p = await browser.getPage("err2")
await p.click("ref/f9e1").catch(e => "caught: " + e.message)`;
    const r3 = await cli.run(H, { stdin: caught });
    expect(r3.code).toBe(0);
    expect(r3.stdout).toMatch(/^caught: Frame f9/);
  }, 20_000);

  test("stack columns before the inserted return( on the last line are not over-shifted", async () => {
    const r = await cli.run([...H, "-e", "const f = () => { throw new Error('x') }; f()"]);
    expect(r.code).toBe(1);
    const m = /    at f \(<eval>:1:(\d+)\)/.exec(r.stderr) ?? /    at <eval>:1:(\d+)/.exec(r.stderr);
    expect(m).not.toBeNull();
    // `throw` is at column 19 (1-based), `new Error` at 25, its `(` at 34; Bun reports the paren. The old
    // bookkeeping subtracted the 8-char `return (` shift from every frame on the line (-> 26/17/11).
    const col = Number(m![1]);
    expect([19, 25, 34]).toContain(col);
  });
});
