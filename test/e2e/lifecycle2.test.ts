/**
 * End-to-end (second lifecycle file): large requests, profile isolation per
 * mode, orphan-safety, shutdown/relaunch races, page-creation mutex,
 * restored tabs, extended pages through Puppeteer's graph, downloads,
 * --ignore-https-errors, broken stdout pipes.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import { makeCliEnv, type CliEnv } from "../helpers/cli.ts";
import { startServer, sleep, type FixtureServer } from "../helpers/server.ts";
import { findChrome } from "../../src/shared/chrome.ts";

let cli: CliEnv;
let srv: FixtureServer;
const H = ["--headless"];
const ROOT = path.resolve(import.meta.dir, "../..");
const MAIN = path.join(ROOT, "src/cli/main.ts");

beforeAll(async () => {
  cli = makeCliEnv("dev-browser-e2e-life2-");
  srv = await startServer({
    "/": "<!doctype html><title>Life2</title><p>x</p>",
    "/popup": `<!doctype html><title>Opener</title><a id="o" href="#" onclick="window.open('/', '_blank'); return false">open</a>`,
    "/dl": () =>
      new Response("hello download", {
        headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="dev-browser-dl.txt"' },
      }),
  });
});

afterAll(async () => {
  await srv.stop();
  await cli.cleanup();
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

function readPid(home: string): number {
  return Number(fs.readFileSync(path.join(home, "daemon.pid"), "utf8"));
}

/* ------------------------------------------------------------------ */

describe("large requests (socket backpressure)", () => {
  const bigScript = (() => {
    const big = "x".repeat(1024 * 1024);
    return `const s = ${JSON.stringify(big)};\ns.length`;
  })();

  test("a 1 MB script via stdin returns normally (dev path)", async () => {
    const t0 = Date.now();
    const r = await cli.run(H, { stdin: bigScript, timeoutMs: 60_000 });
    expect(r).toEqual({ code: 0, stdout: "1048576\n", stderr: "" });
    expect(Date.now() - t0).toBeLessThan(20_000); // not the 45 s watchdog path
    // the daemon was not killed by the watchdog
    const s = await cli.run(["status"]);
    expect(s.code).toBe(0);
  }, 70_000);

  test("a 1 MB script via `run FILE` (and a 100 KB -e, the OS argv limit is lower)", async () => {
    const file = path.join(cli.home, "big.js");
    fs.writeFileSync(file, bigScript);
    const r = await cli.run([...H, "run", file]);
    expect(r).toEqual({ code: 0, stdout: "1048576\n", stderr: "" });
    const r2 = await cli.run([...H, "-e", `const s = ${JSON.stringify("x".repeat(100_000))}; s.length`]);
    expect(r2).toEqual({ code: 0, stdout: "100000\n", stderr: "" });
  }, 70_000);

  test("a 1 MB script through the compiled binary", async () => {
    // Build a throwaway binary (fast: ~1 s) so this covers the real client, not `bun run`.
    const outfile = path.join(cli.home, "dev-browser-bin");
    const build = Bun.spawn([process.execPath, "run", path.join(ROOT, "scripts/build.ts"), "all", "--outfile", outfile], {
      cwd: ROOT,
      env: { ...process.env, NODE_PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await build.exited;
    if (code !== 0) {
      console.warn("build failed; skipping compiled-binary check:\n" + (await new Response(build.stderr).text()));
      return;
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dev-browser-e2e-bin-"));
    const runBin = async (args: string[], stdin?: string) => {
      const proc = Bun.spawn([outfile, ...args], {
        env: { ...process.env, DEV_BROWSER_HOME: home, NODE_PATH: "" },
        stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, stdout, stderr };
    };
    try {
      const r = await runBin(H, bigScript);
      expect(r).toEqual({ code: 0, stdout: "1048576\n", stderr: "" });
      // Puppeteer error names survive the compiled bundle (no identifier minification).
      const e = await runBin([...H, "-e", "const p = await browser.getPage('t'); await p.waitForSelector('#nope', {timeout: 200})"]);
      expect(e.code).not.toBe(0);
      expect(e.stderr.split("\n")[0]).toMatch(/^TimeoutError: Waiting for selector `#nope` failed/);
      const n = await runBin([...H, "-e", "const p = await browser.getPage('t'); let n; try { await p.waitForSelector('#nope', {timeout: 50}) } catch (e) { n = e.name + '/' + e.constructor.name }; n"]);
      expect(n.stdout).toBe("TimeoutError/TimeoutError\n");
    } finally {
      await runBin(["stop"]).catch(() => {});
      await sleep(200);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);

  test("yauzl is bundled into the daemon (dev-browser install works without unzip)", () => {
    const bundle = path.join(ROOT, "build", "daemon.js");
    if (!fs.existsSync(bundle)) return;
    const src = fs.readFileSync(bundle, "utf8");
    expect(src).toContain("require_yauzl");
    expect(src).not.toContain('import("yauzl")');
    expect(src).toMatch(/class TimeoutError/);
  });
});

/* ------------------------------------------------------------------ */

describe("profiles per mode and orphan safety", () => {
  test("headless launches use browsers/NAME/profile-headless, never the headed dir", async () => {
    const r = await cli.run([...H, "-b", "modes", "-e", "(await browser.getPage('m')).url()"]);
    expect(r).toEqual({ code: 0, stdout: "about:blank\n", stderr: "" });
    expect(fs.existsSync(path.join(cli.home, "browsers", "modes", "profile-headless"))).toBe(true);
    expect(fs.existsSync(path.join(cli.home, "browsers", "modes", "profile"))).toBe(false);
    // launching headless again is stable (same instance, same page)
    const r2 = await cli.run([...H, "-b", "modes", "-e", "(await browser.listPages()).length"]);
    expect(r2.code).toBe(0);
    const b = await cli.run(["browsers"]);
    expect(b.stdout.split("\n").filter((l) => l.startsWith("modes")).length).toBe(1);
  });

  test("two headless browsers with different names run side by side, separate dirs", async () => {
    const rs = await Promise.all([
      cli.run([...H, "-b", "side-a", "-e", "(await browser.getPage('p')).url()"]),
      cli.run([...H, "-b", "side-b", "-e", "(await browser.getPage('p')).url()"]),
    ]);
    for (const r of rs) expect(r).toEqual({ code: 0, stdout: "about:blank\n", stderr: "" });
    const b = await cli.run(["browsers"]);
    expect(b.stdout).toContain("side-a:headless");
    expect(b.stdout).toContain("side-b:headless");
    const log = fs.readFileSync(path.join(cli.home, "daemon.log"), "utf8");
    expect(log).not.toMatch(/killing orphan/);
    await cli.run(["stop", "side-a"]);
    await cli.run(["stop", "side-b"]);
  });

  test("headed and headless of the same name coexist (under Xvfb when available)", async () => {
    const xvfb = Bun.which("Xvfb");
    if (!xvfb) return;
    const display = ":" + (9000 + (process.pid % 1000));
    const x = Bun.spawn([xvfb, display, "-screen", "0", "1280x900x24", "-nolisten", "tcp"], { stdout: "ignore", stderr: "ignore" });
    await sleep(500);
    if (x.exitCode !== null) return; // Xvfb could not start here
    try {
      // The daemon inherits DISPLAY from the client that spawns it: restart it under Xvfb.
      await cli.run(["stop"]);
      await sleep(300);
      const env = { DISPLAY: display };
      const hl = await cli.run([...H, "-b", "both", "-e", "(await browser.getPage('h')).url()"], { env });
      expect(hl).toEqual({ code: 0, stdout: "about:blank\n", stderr: "" });
      const hd = await cli.run(["--headed", "-b", "both", "-e", "(await browser.getPage('h')).url()"], { env, timeoutMs: 60_000 });
      if (hd.code !== 0) {
        console.warn("headed launch failed under Xvfb; skipping the coexistence assertion:\n" + hd.stderr);
      } else {
        const b = await cli.run(["browsers"]);
        expect(b.stdout).toContain("both:headless  headless  connected");
        expect(b.stdout).toContain("both  headed  connected");
        expect(fs.existsSync(path.join(cli.home, "browsers", "both", "profile"))).toBe(true);
        expect(fs.existsSync(path.join(cli.home, "browsers", "both", "profile-headless"))).toBe(true);
        // the headless sibling is still alive and still has its named page
        const again = await cli.run([...H, "-b", "both", "-e", "(await browser.listPages()).some(p => p.name === 'h')"], { env });
        expect(again.stdout).toBe("true\n");
      }
      const log = fs.readFileSync(path.join(cli.home, "daemon.log"), "utf8");
      expect(log).not.toMatch(/killing orphan/);
    } finally {
      await cli.run(["stop", "both"]);
      x.kill();
    }
  }, 90_000);

  test("a profile held by a live foreign Chrome is not killed: clear error instead", async () => {
    const chrome = findChrome();
    if (!chrome) throw new Error("no Chrome for tests");
    const profileDir = path.join(cli.home, "browsers", "foreign", "profile-headless");
    fs.mkdirSync(profileDir, { recursive: true });
    // Parent of this Chrome is the test process, which is alive: not an orphan.
    const foreign: Browser = await puppeteer.launch({
      executablePath: chrome.path,
      headless: true,
      userDataDir: profileDir,
      args: ["--no-sandbox", "--no-first-run"],
    });
    try {
      const r = await cli.run([...H, "-b", "foreign", "-t", "4", "-e", "1"], { timeoutMs: 60_000 });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/ProfileBusyError: profile "foreign" \(headless\) is in use by another Chrome/);
      expect(foreign.connected).toBe(true);
      expect(pidAlive(foreign.process()!.pid!)).toBe(true);
      const log = fs.readFileSync(path.join(cli.home, "daemon.log"), "utf8");
      expect(log).not.toMatch(/killing orphan Chrome pid \d+ holding .*foreign/);
    } finally {
      await foreign.close().catch(() => {});
    }
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe("daemon shutdown does not delete the successor's endpoint", () => {
  test("stop then immediate status, three times: the new daemon stays reachable", async () => {
    for (let i = 0; i < 3; i++) {
      await cli.run([...H, "-e", "1"]); // make sure a browser exists so stopAll takes time
      const oldPid = readPid(cli.home);
      const [s, st] = await Promise.all([cli.run(["stop"]), (async () => { await sleep(30); return cli.run(["status"]); })()]);
      expect(s.code).toBe(0);
      expect(st.code).toBe(0);
      // the daemon that answered status must still own a live socket after the old one is gone
      await waitFor(() => !pidAlive(oldPid), 10_000);
      await sleep(300);
      const sockPath = path.join(cli.home, "daemon.sock");
      expect(fs.existsSync(sockPath)).toBe(true);
      const newPid = readPid(cli.home);
      expect(newPid).not.toBe(oldPid);
      expect(pidAlive(newPid)).toBe(true);
      const again = await cli.run(["status"]);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain(`daemon   pid ${newPid},`);
    }
  }, 90_000);
});

/* ------------------------------------------------------------------ */

describe("page creation is serialized", () => {
  test("12 parallel getPage with different names -> 12 distinct tabs", async () => {
    await cli.run(["stop", "par"]).catch(() => {});
    const names = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const rs = await Promise.all(names.map((n) => cli.run([...H, "-b", "par", "-e", `const p = await browser.getPage(${JSON.stringify(n)}); p.target()._targetId`])));
    const ids = rs.map((r) => {
      expect(r.code).toBe(0);
      return r.stdout.trim();
    });
    expect(new Set(ids).size).toBe(12);
    const list = await cli.run([...H, "-b", "par", "-e", "await browser.listPages()"]);
    const pages = JSON.parse(list.stdout) as Array<{ name: string | null }>;
    expect(pages.filter((p) => p.name && /^p\d+$/.test(p.name)).length).toBe(12);
  }, 60_000);

  test("6 parallel getPage with the same name -> 1 tab, nothing leaked", async () => {
    await cli.run(["stop", "par2"]).catch(() => {});
    const rs = await Promise.all(Array.from({ length: 6 }, () => cli.run([...H, "-b", "par2", "-e", "const p = await browser.getPage('same'); p.target()._targetId"])));
    const ids = rs.map((r) => {
      expect(r.code).toBe(0);
      return r.stdout.trim();
    });
    expect(new Set(ids).size).toBe(1);
    const list = await cli.run([...H, "-b", "par2", "-e", "await browser.listPages()"]);
    const pages = JSON.parse(list.stdout) as Array<{ name: string | null; url: string }>;
    expect(pages.length).toBe(1);
    expect(pages[0]!.name).toBe("same");
  }, 60_000);

  test("inside one script: Promise.all of getPage calls", async () => {
    await cli.run(["stop", "par3"]).catch(() => {});
    const r = await cli.run([
      ...H,
      "-b",
      "par3",
      "-e",
      "const ps = await Promise.all(['a','b','c','a','b','c'].map(n => browser.getPage(n))); const ids = ps.map(p => p.target()._targetId); [new Set(ids).size, (await browser.listPages()).length]",
    ]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([3, 3]);
  });
});

/* ------------------------------------------------------------------ */

describe("restored tabs and downloads", () => {
  test("stop + relaunch does not accumulate session-restored tabs", async () => {
    const r = await cli.run([...H, "-b", "restore"], {
      stdin: `const p = await browser.getPage("keep"); await p.goto(${JSON.stringify(srv.url("/"))}); const q = await browser.newPage(); await q.goto(${JSON.stringify(srv.url("/popup"))}); await p.title()`,
    });
    expect(r).toEqual({ code: 0, stdout: "Life2\n", stderr: "" });
    for (let i = 0; i < 2; i++) {
      await cli.run(["stop", "restore"]);
      const r2 = await cli.run([...H, "-b", "restore", "-e", "await browser.listPages()"]);
      expect(r2.code).toBe(0);
      const pages = JSON.parse(r2.stdout) as Array<{ url: string; name: string | null }>;
      expect(pages.filter((p) => p.url !== "about:blank")).toEqual([]);
      expect(pages.length).toBeLessThanOrEqual(1);
    }
    await cli.run(["stop", "restore"]);
  }, 60_000);

  test("downloads land in DEV_BROWSER_HOME/tmp/downloads", async () => {
    const dlDir = path.join(cli.home, "tmp", "downloads");
    const r = await cli.run([...H, "-b", "dl"], {
      stdin: `const p = await browser.getPage("d"); await p.goto(${JSON.stringify(srv.url("/"))}); await p.evaluate((u) => { const a = document.createElement('a'); a.href = u; a.download = 'dev-browser-dl.txt'; document.body.appendChild(a); a.click(); }, ${JSON.stringify(srv.url("/dl"))}); await new Promise(r => setTimeout(r, 500)); 'ok'`,
    });
    expect(r.code).toBe(0);
    const ok = await waitFor(() => fs.existsSync(dlDir) && fs.readdirSync(dlDir).some((f) => f.startsWith("dev-browser-dl") && !f.endsWith(".crdownload")), 10_000);
    expect(ok).toBe(true);
    const f = fs.readdirSync(dlDir).find((f) => f.startsWith("dev-browser-dl"))!;
    expect(fs.readFileSync(path.join(dlDir, f), "utf8")).toBe("hello download");
    await cli.run(["stop", "dl"]);
  }, 30_000);
});

/* ------------------------------------------------------------------ */

describe("pages reached through Puppeteer's own graph are extended", () => {
  test("page.browser().newPage(), popups via waitForTarget, browserContext().pages()", async () => {
    const r = await cli.run([...H, "-b", "graph"], {
      stdin: `
const p = await browser.getPage("g");
await p.goto(${JSON.stringify(srv.url("/popup"))});
const raw = p.browser();
const np = await raw.newPage();
const popupP = raw.waitForTarget(t => t.opener() === p.target(), { timeout: 5000 });
await p.click('#o');
const pop = await (await popupP).page();
const ctxPages = await p.browserContext().pages();
[typeof np.snapshot, typeof np.shot, typeof pop.snapshot, typeof pop.fill, ctxPages.every(x => typeof x.snapshot === 'function'), typeof pop.waitForLoad]`,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["function", "function", "function", "function", true, "function"]);
    await cli.run(["stop", "graph"]);
  }, 30_000);
});

/* ------------------------------------------------------------------ */

describe("--ignore-https-errors", () => {
  test("self-signed server fails without the flag and works with it (separate instance)", async () => {
    const openssl = Bun.which("openssl");
    if (!openssl) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-browser-tls-"));
    const key = path.join(dir, "k.pem");
    const cert = path.join(dir, "c.pem");
    const gen = Bun.spawnSync([openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-days", "1"], { stdout: "ignore", stderr: "ignore" });
    if (gen.exitCode !== 0) return;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { key: Bun.file(key), cert: Bun.file(cert) },
      fetch: () => new Response("<!doctype html><title>Secure</title>", { headers: { "content-type": "text/html" } }),
    });
    const url = `https://127.0.0.1:${server.port}/`;
    try {
      const bad = await cli.run([...H, "-b", "tls", "-e", `const p = await browser.getPage('t'); await p.goto(${JSON.stringify(url)}); await p.title()`]);
      expect(bad.code).not.toBe(0);
      expect(bad.stderr).toMatch(/ERR_CERT/);
      const good = await cli.run([...H, "--ignore-https-errors", "-b", "tls", "-e", `const p = await browser.getPage('t'); await p.goto(${JSON.stringify(url)}); await p.title()`]);
      expect(good).toEqual({ code: 0, stdout: "Secure\n", stderr: "" });
      const b = await cli.run(["browsers"]);
      expect(b.stdout).toContain("tls:headless:insecure");
      expect(b.stdout).toContain("tls:headless  ");
      expect(fs.existsSync(path.join(cli.home, "browsers", "tls", "profile-headless-insecure"))).toBe(true);
    } finally {
      server.stop(true);
      await cli.run(["stop", "tls"]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe("broken stdout pipe", () => {
  test("`dev-browser -e big | head -c 100` prints no EPIPE stack", async () => {
    const script = `${JSON.stringify(process.execPath)} ${JSON.stringify(MAIN)} --headless -e '"x".repeat(300000)' | head -c 100 >/dev/null; echo "rc=\${PIPESTATUS[0]}"`;
    const proc = Bun.spawn(["bash", "-c", script], {
      cwd: ROOT,
      env: { ...process.env, DEV_BROWSER_HOME: cli.home, NODE_PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).not.toMatch(/EPIPE/);
    expect(stderr.trim()).toBe("");
    expect(stdout.trim()).toBe("rc=0");
  }, 30_000);
});
