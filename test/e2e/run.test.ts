/**
 * End-to-end: script execution through the real CLI + daemon + headless Chrome.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeCliEnv, type CliEnv } from "../helpers/cli.ts";
import { startServer, type FixtureServer } from "../helpers/server.ts";

let cli: CliEnv;
let srv: FixtureServer;
const H = ["--headless"];

beforeAll(async () => {
  cli = makeCliEnv("dev-browser-e2e-run-");
  srv = await startServer({
    "/": "<!doctype html><title>Home</title><h1 id=t>hello</h1>",
    "/form": "<!doctype html><title>Form</title><input id=name value='old'><textarea id=ta>x</textarea>",
    "/noisy":
      "<!doctype html><title>Noisy</title><script>console.error('bad thing'); console.warn('meh'); console.log('fine'); setTimeout(() => { throw new Error('kaboom') }, 0)</script>",
    "/hang-load": "<!doctype html><title>Hang</title><p>content</p><img src='/hang.png'>",
    "/hang.png": () => new Promise<Response>(() => {}), // never resolves -> 'load' never fires
  });
  // Warm the daemon + browser once so individual tests stay fast.
  const r = await cli.run([...H, "-e", "1"]);
  expect(r.code).toBe(0);
});

afterAll(async () => {
  await srv.stop();
  await cli.cleanup();
});

describe("basic eval and output", () => {
  test("-e '1+1' -> 2", async () => {
    const r = await cli.run([...H, "-e", "1+1"]);
    expect(r).toEqual({ code: 0, stdout: "2\n", stderr: "" });
  });

  test("stdin script: console.log streams, object return is pretty JSON", async () => {
    const r = await cli.run(H, { stdin: "console.log('hi', 42)\nconst o = { a: 1, b: [1, 2] }\nreturn o" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hi 42\n{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}\n');
    expect(r.stderr).toBe("");
  });

  test("string return is printed raw (no quotes)", async () => {
    const r = await cli.run([...H, "-e", "'plain string'"]);
    expect(r.stdout).toBe("plain string\n");
    const r2 = await cli.run([...H, "-e", "'ends with newline\\n'"]);
    expect(r2.stdout).toBe("ends with newline\n");
  });

  test("undefined return prints nothing; null prints null", async () => {
    const r = await cli.run([...H, "-e", "const a = 1"]);
    expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
    const r2 = await cli.run([...H, "-e", "undefined"]);
    expect(r2.stdout).toBe("");
    const r3 = await cli.run([...H, "-e", "null"]);
    expect(r3.stdout).toBe("null\n");
    const r4 = await cli.run([...H, "-e", "0"]);
    expect(r4.stdout).toBe("0\n");
    const r5 = await cli.run([...H, "-e", "false"]);
    expect(r5.stdout).toBe("false\n");
  });

  test("console.warn/error -> stderr; console.log -> stdout", async () => {
    const r = await cli.run(H, { stdin: "console.warn('w1')\nconsole.error('e1')\nconsole.log('o1')\nconsole.info('i1')" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("o1\ni1\n");
    expect(r.stderr).toBe("w1\ne1\n");
  });

  test("top-level await and fetch work", async () => {
    const r = await cli.run([...H, "-e", `const res = await fetch(${JSON.stringify(srv.url("/"))}); (await res.text()).includes('hello')`]);
    expect(r).toEqual({ code: 0, stdout: "true\n", stderr: "" });
  });

  test("empty stdin script runs as an empty program and exits 0", async () => {
    const r = await cli.run(H, { stdin: "" });
    expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("run FILE", async () => {
    const file = path.join(cli.home, "script.js");
    fs.writeFileSync(file, "const x = 20\nx + 1");
    const r = await cli.run([...H, "run", file]);
    expect(r).toEqual({ code: 0, stdout: "21\n", stderr: "" });
  });

  test("run FILE: missing file is a usage error, not a crash", async () => {
    const r = await cli.run([...H, "run", path.join(cli.home, "nope.js")]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^dev-browser: cannot read .*nope\.js: ENOENT\n$/);
  });
});

describe("errors", () => {
  test("syntax error -> stderr SyntaxError, exit 1", async () => {
    const r = await cli.run(H, { stdin: "const a = 1\nconst b = ;" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^SyntaxError: .*line 2, column \d+/);
  });

  test("thrown TypeError -> name: message, script frame, [page NAME] context, exit 1", async () => {
    const script = `const page = await browser.getPage("errpage")
await page.goto(${JSON.stringify(srv.url("/"))})
throw new TypeError("boom here")`;
    const r = await cli.run(H, { stdin: script });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    const lines = r.stderr.split("\n");
    expect(lines[0]).toBe("TypeError: boom here");
    expect(lines[1]).toMatch(/^    at <stdin>:3:\d+$/);
    expect(r.stderr).toContain(`[page errpage] ${srv.url("/")} "Home"`);
  });

  test("error from -e uses <eval> as the script name and line 1", async () => {
    const r = await cli.run([...H, "-e", "throw new Error('x')"]);
    expect(r.code).toBe(1);
    expect(r.stderr.split("\n")[0]).toBe("Error: x");
    expect(r.stderr.split("\n")[1]).toMatch(/^    at <eval>:1:\d+$/);
  });

  test("script file name appears in stack", async () => {
    const file = path.join(cli.home, "bad.js");
    fs.writeFileSync(file, "\n\nnull.foo");
    const r = await cli.run([...H, "run", file]);
    expect(r.code).toBe(1);
    expect(r.stderr.split("\n")[0]).toMatch(/^TypeError: /);
    expect(r.stderr).toMatch(/    at bad\.js:3:\d+/);
  });

  test("thrown non-Error value", async () => {
    const r = await cli.run([...H, "-e", "throw 'str'"]);
    expect(r.code).toBe(1);
    expect(r.stderr.split("\n")[0]).toBe("Error: str");
  });

  test("--timeout 1 with a 3 s sleep -> TimeoutError, exit 124; next script still works", async () => {
    const t0 = Date.now();
    const r = await cli.run([...H, "--timeout", "1", "-e", "await new Promise(r => setTimeout(r, 3000)); 'late'"]);
    const dt = Date.now() - t0;
    expect(r.code).toBe(124);
    expect(r.stdout).toBe("");
    expect(r.stderr.split("\n")[0]).toBe("TimeoutError: Timed out after 1s (deadline)");
    expect(dt).toBeLessThan(2500);
    const r2 = await cli.run([...H, "-e", "'still alive'"]);
    expect(r2).toEqual({ code: 0, stdout: "still alive\n", stderr: "" });
  });

  test("timeout inside a page action is clamped and still exits 124 with page context", async () => {
    const script = `const page = await browser.getPage("slow")
await page.goto(${JSON.stringify(srv.url("/"))})
await page.waitForSelector("#never", { timeout: 10000 })`;
    const t0 = Date.now();
    const r = await cli.run([...H, "--timeout", "1", ...[], "--json"], { stdin: script });
    expect(Date.now() - t0).toBeLessThan(4000);
    const frames = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    const done = frames.find((f) => f.type === "done");
    expect(done.exitCode).toBe(124);
    const err = frames.find((f) => f.type === "error");
    expect(err.kind).toBe("timeout");
    expect(err.pages.some((p: { name: string }) => p.name === "slow")).toBe(true);
  });
});

describe("--json", () => {
  test("prints NDJSON frames incl. result and done", async () => {
    const r = await cli.run([...H, "--json"], { stdin: "console.log('a');\nconsole.error('b');\n({ v: 1 })" });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const frames = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(frames).toContainEqual({ type: "stdout", data: "a\n" });
    expect(frames).toContainEqual({ type: "stderr", data: "b\n" });
    expect(frames).toContainEqual({ type: "result", value: '{\n  "v": 1\n}', data: { v: 1 } });
    const done = frames[frames.length - 1];
    expect(done.type).toBe("done");
    expect(done.exitCode).toBe(0);
    expect(typeof done.durationMs).toBe("number");
    // no hello frame leaks to the consumer
    expect(frames.some((f) => f.type === "hello")).toBe(false);
  });

  test("--json error frame", async () => {
    const r = await cli.run([...H, "--json", "-e", "throw new RangeError('r')"]);
    expect(r.code).toBe(1);
    const frames = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    const err = frames.find((f) => f.type === "error");
    expect(err).toMatchObject({ kind: "script", name: "RangeError", message: "r" });
    expect(err.stack).toMatch(/<eval>:1:\d+/);
    expect(frames[frames.length - 1]).toMatchObject({ type: "done", exitCode: 1 });
  });
});

describe("output cap", () => {
  test("console.log 120k chars -> capped marker + spill file with everything", async () => {
    const r = await cli.run(H, { stdin: "console.log('x'.repeat(120000))" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("[... stdout capped at 50000 chars, 120001 total");
    const m = /full output: (\S+out-[^ ]+\.txt)/.exec(r.stdout);
    expect(m).not.toBeNull();
    const spill = m![1]!;
    expect(spill.startsWith(path.join(cli.home, "tmp"))).toBe(true);
    expect(fs.readFileSync(spill, "utf8")).toBe("x".repeat(120000) + "\n");
    // head streamed (50k), tail printed (5k)
    expect(r.stdout.startsWith("x".repeat(50000) + "\n[... stdout capped")).toBe(true);
    expect(r.stdout).toContain("[... last 5000 chars ...]\n" + "x".repeat(4999) + "\n");
  });

  test("--no-cap prints everything", async () => {
    const r = await cli.run([...H, "--no-cap"], { stdin: "console.log('y'.repeat(120000))" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("y".repeat(120000) + "\n");
  });
});

describe("page console collection", () => {
  test("page console.error + uncaught -> stderr [page:NAME] lines", async () => {
    const script = `const page = await browser.getPage("main")
await page.goto(${JSON.stringify(srv.url("/noisy"))})
await new Promise(r => setTimeout(r, 200))
'ok'`;
    const r = await cli.run(H, { stdin: script });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("ok\n");
    expect(r.stderr).toContain("[page:main] error: bad thing");
    expect(r.stderr).toContain("[page:main] warn: meh");
    expect(r.stderr).toContain("[page:main] uncaught: kaboom");
    expect(r.stderr).not.toContain("fine");
  });

  test("--quiet-page suppresses", async () => {
    const script = `const page = await browser.getPage("main")
await page.goto(${JSON.stringify(srv.url("/noisy"))})
await new Promise(r => setTimeout(r, 200))
'ok'`;
    const r = await cli.run([...H, "--quiet-page"], { stdin: script });
    expect(r).toEqual({ code: 0, stdout: "ok\n", stderr: "" });
  });
});

describe("script globals and page helpers", () => {
  test("saveFile/readFile round trip; saveFile('../x') throws", async () => {
    const script = `const p = saveFile("rt.txt", "hello 123")
console.log(p)
console.log(readFile("rt.txt"))
try { saveFile("../x", "bad"); console.log("NO THROW") } catch (e) { console.log("threw:", e.message) }
try { saveFile("/tmp/abs", "bad"); console.log("NO THROW") } catch (e) { console.log("threw abs") }`;
    const r = await cli.run(H, { stdin: script });
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toBe(path.join(cli.home, "tmp", "rt.txt"));
    expect(fs.readFileSync(lines[0]!, "utf8")).toBe("hello 123");
    expect(lines[1]).toBe("hello 123");
    expect(lines[2]).toMatch(/^threw: /);
    expect(lines[3]).toBe("threw abs");
  });

  test("page.shot() prints [image] path (WxH) and writes a JPEG", async () => {
    const script = `const page = await browser.getPage("shotpage")
await page.goto(${JSON.stringify(srv.url("/"))})
const s = await page.shot()
console.log(JSON.stringify(s))`;
    const r = await cli.run(H, { stdin: script });
    expect(r.code).toBe(0);
    const m = /^\[image\] (\S+) \((\d+)x(\d+)\)$/m.exec(r.stdout);
    expect(m).not.toBeNull();
    const file = m![1]!;
    expect(fs.existsSync(file)).toBe(true);
    const head = fs.readFileSync(file).subarray(0, 3);
    expect([...head]).toEqual([0xff, 0xd8, 0xff]);
    expect(Number(m![2])).toBe(1280);
    expect(Number(m![3])).toBe(720);
    const s = JSON.parse(r.stdout.split("\n").find((l) => l.startsWith("{"))!);
    expect(s.path).toBe(file);
    expect(s.width).toBe(1280);
  });

  test("page.shot() in --json mode emits an image frame", async () => {
    const script = `const page = await browser.getPage("shotpage")
await page.goto(${JSON.stringify(srv.url("/"))})
await page.shot()`;
    const r = await cli.run([...H, "--json"], { stdin: script });
    const frames = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    const img = frames.find((f) => f.type === "image");
    expect(img).toBeDefined();
    expect(img.width).toBe(1280);
    expect(fs.existsSync(img.path)).toBe(true);
  });

  test("page.fill replaces an input's value", async () => {
    const script = `const page = await browser.getPage("fillpage")
await page.goto(${JSON.stringify(srv.url("/form"))})
await page.fill("#name", "new value")
await page.fill("#ta", "multi");
[await page.$eval("#name", e => e.value), await page.$eval("#ta", e => e.value)]`;
    const r = await cli.run(H, { stdin: script });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["new value", "multi"]);
  });

  test("page.goto defaults to domcontentloaded (load never fires)", async () => {
    const script = `const page = await browser.getPage("hangpage")
const t0 = Date.now()
await page.goto(${JSON.stringify(srv.url("/hang-load"))})
const dt = Date.now() - t0
const txt = await page.$eval("p", e => e.textContent);
({ txt, fast: dt < 5000 })`;
    const r = await cli.run([...H, "--timeout", "20"], { stdin: script });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ txt: "content", fast: true });
  });

  test("Puppeteer objects are tamed in console output", async () => {
    const script = `const page = await browser.getPage("tame")
await page.goto(${JSON.stringify(srv.url("/"))})
console.log(page)
const h = await page.$("h1")
console.log({ h })
page`;
    const r = await cli.run(H, { stdin: script });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`[Page ${srv.url("/")}]`);
    expect(r.stdout).toContain("[ElementHandle]");
  });
});

describe("concurrency", () => {
  test("two scripts sleeping 600 ms finish in < 1.5 s total", async () => {
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      cli.run([...H, "-e", "await new Promise(r => setTimeout(r, 600)); 'a'"]),
      cli.run([...H, "-e", "await new Promise(r => setTimeout(r, 600)); 'b'"]),
    ]);
    const dt = Date.now() - t0;
    expect(a.stdout).toBe("a\n");
    expect(b.stdout).toBe("b\n");
    expect(dt).toBeLessThan(1500);
  });
});

describe("stack columns", () => {
  test("ReferenceError in a one-line -e points at the real column", async () => {
    const r = await cli.run([...H, "-e", "const a = 1; nope(a)"]);
    expect(r.code).toBe(1);
    // `nope(a)` starts at column 14; Bun reports the call paren area, so accept 14..18
    const m = /    at <eval>:1:(\d+)/.exec(r.stderr);
    expect(m).not.toBeNull();
    const col = Number(m![1]);
    expect(col).toBeGreaterThanOrEqual(14);
    expect(col).toBeLessThanOrEqual(18);
  });
});

describe("page console cap", () => {
  test("at most 20 [page:...] lines are printed", async () => {
    srv.set("/spam", "<!doctype html><script>for (let i = 0; i < 40; i++) console.error('spam ' + i)</script>");
    const script = `const page = await browser.getPage("spam")
await page.goto(${JSON.stringify(srv.url("/spam"))})
await new Promise(r => setTimeout(r, 150))
'ok'`;
    const r = await cli.run(H, { stdin: script });
    expect(r.code).toBe(0);
    const lines = r.stderr.split("\n").filter((l) => l.startsWith("[page:spam]"));
    expect(lines.length).toBe(20);
    expect(lines[0]).toBe("[page:spam] error: spam 0");
  });
});
