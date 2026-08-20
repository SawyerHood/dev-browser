/**
 * End-to-end (CLI + daemon + headless Chrome): front lock across concurrent
 * runs, gate coverage for escaped handles/browser/frames, page identity,
 * request interception cleanup, per-page timeout reset, beforeunload,
 * cross-realm error logging, failed-goto page line, doobie stop under a run.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { makeCliEnv, type CliEnv } from "../helpers/cli.ts";
import { startServer, sleep, type FixtureServer } from "../helpers/server.ts";

let cli: CliEnv;
let srv: FixtureServer;
const H = ["--headless"];
const q = (s: string) => JSON.stringify(s);
const BTN = "<!doctype html><title>Btn</title><button id=b onclick=\"this.textContent=(+this.textContent||0)+1\">0</button>";

beforeAll(async () => {
  cli = makeCliEnv("doobie-e2e-rt3-");
  srv = await startServer({
    "/": "<!doctype html><title>Home</title><h1 id=t>hello</h1>",
    "/btn": BTN,
    "/page2": "<!doctype html><title>Page2</title><p>two</p>",
    "/popup": "<!doctype html><title>Pop</title><a href='/page2' target=_blank id=l>open</a>",
    "/slow": async () => {
      await sleep(1200);
      return "<!doctype html><title>Slow</title>";
    },
  });
  const r = await cli.run([...H, "-e", "1"]);
  expect(r.code).toBe(0);
});

afterAll(async () => {
  await srv.stop();
  await cli.cleanup();
});

describe("front lock", () => {
  test("two concurrent scripts clicking 40x on two pages of one browser both finish", async () => {
    const script = (name: string) => `const p = await browser.getPage(${q(name)})
await p.goto(${q(srv.url("/btn"))})
for (let i = 0; i < 40; i++) await p.click("#b")
await p.$eval("#b", b => b.textContent)`;
    const t0 = Date.now();
    const [a, b] = await Promise.all([cli.run([...H, "-t", "20"], { stdin: script("fA") }), cli.run([...H, "-t", "20"], { stdin: script("fB") })]);
    expect(a.stderr).toBe("");
    expect(b.stderr).toBe("");
    expect(a.stdout).toBe("40\n");
    expect(b.stdout).toBe("40\n");
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 40_000);

  test("an external Target.activateTarget between actions does not stall the next click/shot", async () => {
    const script = `const a = await browser.getPage("extA")
await a.goto(${q(srv.url("/btn"))})
const b = await browser.getPage("extB")
await b.goto(${q(srv.url("/btn"))})
await a.click("#b")
// someone else (user, another CDP client) activates B without any target churn
const s = await a.target().createCDPSession()
const ids = (await browser.listPages()).filter(x => x.name === "extB").map(x => x.id)
await s.send("Target.activateTarget", { targetId: ids[0] })
await s.detach()
await new Promise(r => setTimeout(r, 500))
const t0 = Date.now()
await a.click("#b")
const shot = await a.shot()
const dt = Date.now() - t0;
({ n: await a.$eval("#b", b => b.textContent), fast: dt < 3000, w: shot.width })`;
    const r = await cli.run([...H, "-t", "15"], { stdin: script });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const v = JSON.parse(r.stdout.split("\n").filter((l) => !l.startsWith("[image]")).join("\n"));
    expect(v).toEqual({ n: "2", fast: true, w: 1280 });
  }, 30_000);

  test("waitForSelector({visible}) on a background tab resolves", async () => {
    const script = `const h = ${q(srv.url("/btn"))}
const B = await browser.getPage("W1"); await B.goto(h)
const A = await browser.getPage("W2"); await A.goto(h)
await A.click("#b")
await B.evaluate(() => setTimeout(() => document.body.insertAdjacentHTML("beforeend", "<div id=l>hi</div>"), 300))
const t0 = Date.now()
await B.waitForSelector("#l", { visible: true, timeout: 3000 })
Date.now() - t0 < 2500`;
    const r = await cli.run([...H, "-t", "15"], { stdin: script });
    expect(r).toEqual({ code: 0, stdout: "true\n", stderr: "" });
  }, 30_000);
});

describe("gate coverage beyond the page proxy", () => {
  test("a zombie holding an ElementHandle stops after the run; page.on() returns the proxy", async () => {
    const zombie = `const p = await browser.getPage("zh")
await p.goto("data:text/html,<body data-n=0>")
const h = await p.$("body")
let err = null;
(async () => { try { for (;;) { await h.evaluate(e => e.dataset.n = +e.dataset.n + 1) } } catch (e) { err = e } })()
await new Promise(r => setTimeout(r, 100))
p.on("console", () => {}) === p`;
    const r = await cli.run([...H, "-t", "10"], { stdin: zombie });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("true\n");
    await sleep(300);
    const probe = `const p = await browser.getPage("zh")
const a = await p.$eval("body", e => e.dataset.n)
await new Promise(r => setTimeout(r, 500))
const b = await p.$eval("body", e => e.dataset.n)
a === b`;
    const r2 = await cli.run([...H, "-t", "10"], { stdin: probe });
    expect(r2).toEqual({ code: 0, stdout: "true\n", stderr: "" });
  }, 30_000);

  test("page.browser().pages() returns the same proxies as getPage; popups and frame.page() keep identity", async () => {
    const script = `const page = await browser.getPage("idm")
await page.goto(${q(srv.url("/popup"))})
const [pop] = await Promise.all([new Promise(r => page.once("popup", r)), page.click("#l")])
await pop.waitForSelector("p")
const pages = await page.browser().pages()
const out = {
  includesProxy: pages.includes(page),
  popInPages: pages.includes(pop),
  otherIsPop: pages.filter(p => p !== page).includes(pop),
  frameIdentity: page.mainFrame().page() === page,
  onReturnsProxy: page.on("console", () => {}) === page,
  browserStable: page.browser() === pop.browser(),
  popTitle: await pop.title(),
}
await pop.close()
out`;
    const r = await cli.run([...H, "-t", "15"], { stdin: script });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      includesProxy: true,
      popInPages: true,
      otherIsPop: true,
      frameIdentity: true,
      onReturnsProxy: true,
      browserStable: true,
      popTitle: "Page2",
    });
  }, 30_000);

  test("pages reached through browser().pages() are gated: a zombie loop on one stops at run end", async () => {
    const script = `const page = await browser.getPage("gp")
await page.goto(${q(srv.url("/"))})
const same = (await page.browser().pages()).find(p => p === page)
;(async () => { try { for (;;) await same.evaluate(() => { document.title = "zombie" }) } catch {} })()
await new Promise(r => setTimeout(r, 100))
"ok"`;
    const r = await cli.run([...H, "-t", "10"], { stdin: script });
    expect(r.stdout).toBe("ok\n");
    await sleep(200);
    const next = `const p = await browser.getPage("gp")
await p.evaluate(() => { document.title = "mine" })
await new Promise(r => setTimeout(r, 500))
await p.title()`;
    const r2 = await cli.run([...H, "-t", "10"], { stdin: next });
    expect(r2.stdout).toBe("mine\n");
  }, 30_000);
});

describe("per-page state left by a script", () => {
  test("request interception enabled by one script is switched off at run end; the next script navigates", async () => {
    const first = `const p = await browser.getPage("ri")
await p.setRequestInterception(true)
p.on("request", r => r.continue())
await p.goto(${q(srv.url("/"))})
await p.title()`;
    const r = await cli.run([...H, "-t", "15"], { stdin: first });
    expect(r).toEqual({ code: 0, stdout: "Home\n", stderr: "" });
    const second = `const p = await browser.getPage("ri")
await p.goto(${q(srv.url("/page2"))}, { timeout: 4000 })
await p.title()`;
    const r2 = await cli.run([...H, "-t", "15"], { stdin: second });
    expect(r2).toEqual({ code: 0, stdout: "Page2\n", stderr: "" });
  }, 30_000);

  test("setDefaultTimeout/setDefaultNavigationTimeout do not leak into the next script", async () => {
    const first = `const p = await browser.getPage("dt")
p.setDefaultTimeout(100); p.setDefaultNavigationTimeout(200); "set"`;
    expect((await cli.run(H, { stdin: first })).stdout).toBe("set\n");
    const second = `const p = await browser.getPage("dt")
const t0 = Date.now()
await p.goto(${q(srv.url("/slow"))})
const nav = Date.now() - t0
let waited = 0
try { await p.waitForSelector("#zzz", { timeout: 600 }) } catch (e) { waited = Date.now() - t0 - nav }
({ navOk: nav > 1000, waited: waited >= 550 })`;
    const r2 = await cli.run([...H, "-t", "15"], { stdin: second });
    expect(r2.stderr).toBe("");
    expect(JSON.parse(r2.stdout)).toEqual({ navOk: true, waited: true });
  }, 30_000);

  test("beforeunload dialogs are auto-accepted so the navigation proceeds", async () => {
    const script = `const p = await browser.getPage("bu")
await p.goto(${q(srv.url("/"))})
await p.evaluate(() => { window.onbeforeunload = () => "x" })
await p.click("#t") // user gesture so Chrome shows the beforeunload prompt
await p.goto(${q(srv.url("/page2"))})
await p.title()`;
    const r = await cli.run([...H, "-t", "15"], { stdin: script });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Page2\n");
    expect(r.stderr).toContain("[page:bu] dialog beforeunload:");
    expect(r.stderr).toContain("(auto-accepted)");
  }, 30_000);
});

describe("errors and logs", () => {
  test("cross-realm script errors reach the daemon log as Name: message", async () => {
    const script = `setTimeout(() => { throw new Error("async throw from script") }, 10)
Promise.reject(new TypeError("rejected in script"))
await new Promise(r => setTimeout(r, 200))
"ok"`;
    const r = await cli.run(H, { stdin: script });
    expect(r.stdout).toBe("ok\n");
    await sleep(200);
    const log = fs.readFileSync(path.join(cli.home, "daemon.log"), "utf8");
    expect(log).toContain("Error: async throw from script");
    expect(log).toContain("TypeError: rejected in script");
    expect(log).not.toMatch(/uncaughtException \{\}|unhandledRejection \{\}/);
  }, 20_000);

  test("after a failed goto the [page] line names the attempted URL", async () => {
    const script = `const p = await browser.getPage("fg")
await p.goto(${q(srv.url("/"))})
await p.goto("http://127.0.0.1:1/")`;
    const r = await cli.run([...H, "-t", "15"], { stdin: script });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^Error: net::ERR_/m);
    expect(r.stderr).toContain(`[page fg] `);
    expect(r.stderr).toContain(`(goto "http://127.0.0.1:1/" failed)`);
  }, 20_000);

  test("doobie stop during a run surfaces as BrowserStoppedError", async () => {
    const script = `const p = await browser.getPage("stopme")
for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 250)); await p.title() }`;
    const running = cli.run([...H, "-t", "20"], { stdin: script });
    await sleep(1500);
    const st = await cli.run(["stop"]);
    expect(st.code).toBe(0);
    const r = await running;
    expect(r.code).toBe(1);
    expect(r.stderr.split("\n")[0]).toMatch(/^BrowserStoppedError: browser "default:headless" was stopped while the script was running/);
  }, 30_000);
});

describe("relative file paths resolve against the caller's cwd", () => {
  test("uploadFile, page.screenshot({path}), handle.screenshot({path}) and pdf({path})", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doobie-cwd-"));
    fs.writeFileSync(path.join(dir, "up.txt"), "hello upload");
    const script = `const p = await browser.getPage("cwd");
await p.setContent('<input type=file id=f><div id=d style="width:40px;height:40px;background:red"></div>');
const f = await p.$("#f"); await f.uploadFile("up.txt");
const name = await p.$eval("#f", e => e.files[0].name);
await p.screenshot({ path: "page.png" });
const d = await p.$("#d"); await d.screenshot({ path: "el.png" });
await p.pdf({ path: "doc.pdf" });
name`;
    const r = await cli.run([...H], { stdin: script, cwd: dir });
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("up.txt");
    for (const f of ["page.png", "el.png", "doc.pdf"]) expect(fs.existsSync(path.join(dir, f))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});

describe("realm", () => {
  test("instanceof Error holds for Puppeteer errors and script errors", async () => {
    const r = await cli.run([...H, "-e", 'const p = await browser.getPage("realm"); let a, b; try { await p.click("#nope") } catch (e) { a = e instanceof Error } try { throw new TypeError("x") } catch (e) { b = e instanceof Error && e instanceof TypeError } [a, b]']);
    expect(JSON.parse(r.stdout)).toEqual([true, true]);
    expect(r.code).toBe(0);
  }, 20_000);
});
