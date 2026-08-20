/**
 * End-to-end (third lifecycle file): attached browsers (--connect) leave the
 * user's own tabs alone (no eager extendPage: no dialog auto-dismiss, no load
 * tracker) while doobie's pages, their popups, and tabs reached via
 * getPage(targetId) are extended; pages/status requests do not reset a
 * browser's --idle-timeout.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { makeCliEnv, type CliEnv } from "../helpers/cli.ts";
import { startServer, sleep, type FixtureServer } from "../helpers/server.ts";
import { findChrome } from "../../src/shared/chrome.ts";

let cli: CliEnv;
let srv: FixtureServer;
const H = ["--headless"];

beforeAll(async () => {
  cli = makeCliEnv("doobie-e2e-life3-");
  srv = await startServer({
    "/": "<!doctype html><title>Life3</title><p>x</p>",
    "/popup": `<!doctype html><title>Opener</title><a id="o" href="#" onclick="window.open('/', '_blank'); return false">open</a>`,
  });
});

afterAll(async () => {
  await srv.stop();
  await cli.cleanup();
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

/**
 * From the user's own client: run confirm() in a tab. If doobie's dialog
 * auto-dismiss is installed on that tab the call returns false at once; an
 * untouched tab waits for our own handler, which accepts after 300 ms.
 */
async function confirmFromUser(page: Page): Promise<boolean> {
  const onDialog = (d: { accept: () => Promise<void> }) => {
    setTimeout(() => void d.accept().catch(() => {}), 300);
  };
  page.on("dialog", onDialog);
  try {
    return await page.evaluate(() => confirm("sure?"));
  } finally {
    page.off("dialog", onDialog);
  }
}

function targetIdOf(page: Page): string {
  return (page.target() as unknown as { _targetId: string })._targetId;
}

describe("--connect: the user's own tabs are not extended", () => {
  let ext: Browser | null = null;
  let port = 0;
  let userDataDir = "";

  beforeAll(async () => {
    const chrome = findChrome();
    if (!chrome) throw new Error("no Chrome for tests");
    port = await freePort();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "doobie-ext3-chrome-"));
    // The test's puppeteer is "the user's second client" on this Chrome.
    ext = await puppeteer.launch({
      executablePath: chrome.path,
      headless: true,
      args: ["--no-sandbox", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`],
    });
    const r = await cli.run(["--connect", String(port), "-e", `const p = await browser.getPage("mine"); await p.goto(${JSON.stringify(srv.url("/"))}); await p.title()`]);
    expect(r).toEqual({ code: 0, stdout: "Life3\n", stderr: "" });
  }, 60_000);

  afterAll(async () => {
    await cli.run(["stop"]).catch(() => {});
    if (ext) await ext.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test("a tab the user opens while doobie is attached keeps its dialogs and gets no load tracker", async () => {
    const userPage = await ext!.newPage();
    await userPage.goto(srv.url("/"));
    await sleep(300); // give an (unwanted) eager targetcreated->extendPage a chance to land
    expect(await confirmFromUser(userPage)).toBe(true);
    await userPage.goto(srv.url("/popup"));
    expect(await userPage.evaluate(() => typeof (window as unknown as { __doobieLoad?: unknown }).__doobieLoad)).toBe("undefined");
    // and doobie did not report it as one of its pages in that run's stderr (nothing ran)
    await userPage.close();
  }, 30_000);

  test("a popup opened from the user's tab is not extended either", async () => {
    const userPage = await ext!.newPage();
    await userPage.goto(srv.url("/popup"));
    const popupP = ext!.waitForTarget((t) => t.opener() === userPage.target(), { timeout: 5000 });
    await userPage.click("#o");
    const popup = await (await popupP).page();
    expect(popup).not.toBeNull();
    await sleep(300);
    expect(await confirmFromUser(popup!)).toBe(true);
    await popup!.close();
    await userPage.close();
  }, 30_000);

  test("doobie's own named page auto-dismisses dialogs (extended)", async () => {
    const r = await cli.run(["--connect", String(port), "-e", `const p = await browser.getPage("mine"); await p.evaluate(() => confirm("x"))`]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("false\n");
    expect(r.stderr).toMatch(/\[page:mine\] dialog confirm: x \(auto-dismissed\)/);
  }, 30_000);

  test("a popup opened from a doobie page is extended (opener is a touched page)", async () => {
    const r = await cli.run(["--connect", String(port)], {
      stdin: `
const p = await browser.getPage("mine");
await p.goto(${JSON.stringify(srv.url("/popup"))});
const raw = p.browser();
const popupP = raw.waitForTarget(t => t.opener() === p.target(), { timeout: 5000 });
await p.click('#o');
const pop = await (await popupP).page();
const r = [typeof pop.snapshot, typeof pop.shot, await pop.evaluate(() => confirm("pop?"))];
await pop.close();
r`,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["function", "function", false]);
  }, 30_000);

  test("a user tab reached via getPage(targetId) is extended lazily, on first access", async () => {
    const userPage = await ext!.newPage();
    await userPage.goto(srv.url("/"));
    const id = targetIdOf(userPage);
    await sleep(200);
    expect(await confirmFromUser(userPage)).toBe(true); // untouched so far
    const r = await cli.run(["--connect", String(port), "-e", `const p = await browser.getPage(${JSON.stringify(id)}); [typeof p.snapshot, await p.evaluate(() => confirm("now?"))]`]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["function", false]);
    // and it stays extended (doobie touched it): the user's confirm is now auto-dismissed
    expect(await confirmFromUser(userPage)).toBe(false);
    await userPage.close();
  }, 30_000);

  test("browser.newPage() from a script is extended; listPages shows the user's tabs without touching them", async () => {
    const userPage = await ext!.newPage();
    await userPage.goto(srv.url("/"));
    const id = targetIdOf(userPage);
    const r = await cli.run(["--connect", String(port), "-e", `const np = await browser.newPage(); const l = await browser.listPages(); const x = [typeof np.snapshot, l.some(p => p.id === ${JSON.stringify(id)} && p.name === null)]; await np.close(); x`]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["function", true]);
    expect(await confirmFromUser(userPage)).toBe(true);
    await userPage.close();
  }, 30_000);
});

/* ------------------------------------------------------------------ */

describe("pages/status do not reset --idle-timeout", () => {
  async function idleTimeoutOf(key: string): Promise<number | undefined> {
    const j = await cli.run(["browsers", "--json"]);
    const frames = j.stdout.trim().split("\n").map((l) => JSON.parse(l));
    const data = frames.find((f) => f.type === "data");
    return (data.payload as Array<{ key: string; idleTimeoutMs: number }>).find((b) => b.key === key)?.idleTimeoutMs;
  }

  test("`doobie pages -b NAME` and `status` keep the previously chosen idle timeout; a run with a new one changes it", async () => {
    const r = await cli.run([...H, "-b", "idle3", "--idle-timeout", "5m", "-e", "1"]);
    expect(r.code).toBe(0);
    expect(await idleTimeoutOf("idle3:headless")).toBe(5 * 60 * 1000);
    const p = await cli.run([...H, "-b", "idle3", "pages"]);
    expect(p.code).toBe(0);
    expect(p.stdout).toContain("idle3:headless");
    expect(await idleTimeoutOf("idle3:headless")).toBe(5 * 60 * 1000);
    const s = await cli.run([...H, "-b", "idle3", "status"]);
    expect(s.code).toBe(0);
    expect(await idleTimeoutOf("idle3:headless")).toBe(5 * 60 * 1000);
    const b = await cli.run(["browsers"]);
    expect(b.stdout).toMatch(/idle3:headless  headless  connected  \d+ page\(s\)  idle \d+s\/5m/);
    // a run without --idle-timeout uses the default again (run requests carry the user's choice)
    const r2 = await cli.run([...H, "-b", "idle3", "--idle-timeout", "7m", "-e", "1"]);
    expect(r2.code).toBe(0);
    expect(await idleTimeoutOf("idle3:headless")).toBe(7 * 60 * 1000);
    await cli.run(["stop", "idle3"]);
  }, 60_000);

  test("`doobie pages -b NEW` on a not-yet-running browser launches it with the default idle timeout", async () => {
    const p = await cli.run([...H, "-b", "idle3b", "pages"]);
    expect(p.code).toBe(0);
    expect(await idleTimeoutOf("idle3b:headless")).toBe(30 * 60 * 1000);
    await cli.run(["stop", "idle3b"]);
  }, 60_000);
});
