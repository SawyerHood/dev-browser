/**
 * End-to-end: daemon/browser lifecycle, info subcommands, usage/help, --connect.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import { makeCliEnv, type CliEnv } from "../helpers/cli.ts";
import { startServer, sleep, type FixtureServer } from "../helpers/server.ts";
import { findChrome } from "../../src/shared/chrome.ts";
import { VERSION } from "../../src/shared/version.ts";

let cli: CliEnv;
let srv: FixtureServer;
const H = ["--headless"];

beforeAll(async () => {
  cli = makeCliEnv("doobie-e2e-life-");
  srv = await startServer({ "/": "<!doctype html><title>Life</title><p>x</p>" });
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

describe("usage, version, help (no daemon needed)", () => {
  test("unknown flag -> exit 2 with a doobie: message", async () => {
    const r = await cli.run(["--bogus"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("doobie: unknown flag --bogus\n");
  });

  test("unknown command -> exit 2", async () => {
    const r = await cli.run(["frob"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown command "frob"/);
  });

  test("--version", async () => {
    const r = await cli.run(["--version"]);
    expect(r).toEqual({ code: 0, stdout: `doobie ${VERSION}\n`, stderr: "" });
  });

  test("--help contains USAGE and the version", async () => {
    const r = await cli.run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("USAGE");
    expect(r.stdout).toContain(VERSION);
    expect(r.stdout).not.toContain("{{VERSION}}");
    const r2 = await cli.run(["help"]);
    expect(r2.stdout).toBe(r.stdout);
  });

  test("help <topic> prints only that section or a topic list", async () => {
    const r = await cli.run(["help", "connect"]);
    expect(r.code).toBe(0);
    if (r.stdout.startsWith("## connect")) {
      // exactly one section
      expect(r.stdout.match(/^## /gm)!.length).toBe(1);
    } else {
      expect(r.stdout).toMatch(/^No help topic "connect"\. Topics: /);
    }
    const r2 = await cli.run(["help", "quickstart"]);
    expect(r2.code).toBe(0);
    expect(r2.stdout.startsWith("## quickstart")).toBe(true);
    expect(r2.stdout.match(/^## /gm)!.length).toBe(1);
  });

  test("--timeout validation is a usage error", async () => {
    const r = await cli.run(["--timeout", "0", "-e", "1"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--timeout/);
  });

  test("bad --idle-timeout is a usage error", async () => {
    const r = await cli.run(["--idle-timeout", "soon", "-e", "1"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/invalid duration/);
  });

  test("chrome --list prints at least one candidate", async () => {
    const r = await cli.run(["chrome", "--list"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toMatch(/^(env|config|installed|system|playwright)\s+\//);
  });

  test("chrome with an unknown flag is a usage error", async () => {
    const r = await cli.run(["chrome", "--wat"]);
    expect(r.code).toBe(2);
  });

  test("install-skill writes SKILL.md under HOME", async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "doobie-home-"));
    try {
      const r = await cli.run(["install-skill", "--claude"], { env: { HOME: fakeHome } });
      expect(r.code).toBe(0);
      const file = path.join(fakeHome, ".claude", "skills", "doobie", "SKILL.md");
      expect(r.stdout).toBe(`wrote ${file}\n`);
      expect(fs.existsSync(file)).toBe(true);
      const content = fs.readFileSync(file, "utf8");
      expect(content.length).toBeGreaterThan(20);
      expect(content).not.toContain("{{VERSION}}");
      expect(fs.existsSync(path.join(fakeHome, ".codex"))).toBe(false);
      // no flags: all three targets
      const r2 = await cli.run(["install-skill"], { env: { HOME: fakeHome } });
      expect(r2.code).toBe(0);
      expect(fs.existsSync(path.join(fakeHome, ".codex", "skills", "doobie", "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(fakeHome, ".agents", "skills", "doobie", "SKILL.md"))).toBe(true);
      // unknown target
      const r3 = await cli.run(["install-skill", "--vim"], { env: { HOME: fakeHome } });
      expect(r3.code).toBe(2);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("daemon and browser lifecycle", () => {
  test("first run spawns the daemon: pid file, socket, log", async () => {
    const r = await cli.run([...H, "-e", "'up'"]);
    expect(r).toEqual({ code: 0, stdout: "up\n", stderr: "" });
    expect(fs.existsSync(path.join(cli.home, "daemon.sock"))).toBe(true);
    const pid = Number(fs.readFileSync(path.join(cli.home, "daemon.pid"), "utf8"));
    expect(pidAlive(pid)).toBe(true);
    expect(fs.readFileSync(path.join(cli.home, "daemon.log"), "utf8")).toMatch(/listening on/);
    // spawn lock is released
    expect(fs.existsSync(path.join(cli.home, "daemon.lock"))).toBe(false);
  });

  test("browsers output shape", async () => {
    const r = await cli.run(["browsers"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^default:headless  headless  connected  \d+ page\(s\)  idle \d+s\/30m\n$/);
    const j = await cli.run(["browsers", "--json"]);
    const frames = j.stdout.trim().split("\n").map((l) => JSON.parse(l));
    const data = frames.find((f) => f.type === "data");
    expect(data.payload).toHaveLength(1);
    expect(data.payload[0]).toMatchObject({ key: "default:headless", kind: "launch", name: "default", headless: true, connected: true, idleTimeoutMs: 30 * 60 * 1000 });
    expect(typeof data.payload[0].wsEndpoint).toBe("string");
    expect(typeof data.payload[0].pages).toBe("number");
  });

  test("status output shape", async () => {
    const r = await cli.run(["status"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toMatch(new RegExp(`^daemon   pid \\d+, v${VERSION.replace(/\\./g, "\\\\.")}, up \\d+s$`));
    expect(lines[1]).toBe(`socket   ${path.join(cli.home, "daemon.sock")}`);
    expect(lines[2]).toBe(`log      ${path.join(cli.home, "daemon.log")}`);
    expect(lines[3]).toBe("runs     0 active");
    expect(lines[4]).toBe("browsers 1");
    expect(lines[5]).toMatch(/^  default:headless  headless  connected/);
    expect(r.stdout).toContain("log tail:");
    const j = await cli.run(["status", "--json"]);
    const data = j.stdout.trim().split("\n").map((l) => JSON.parse(l)).find((f) => f.type === "data");
    expect(Object.keys(data.payload).sort()).toEqual(["activeRuns", "browsers", "logPath", "logTail", "pid", "socketPath", "uptimeMs", "version"]);
    expect(data.payload.version).toBe(VERSION);
    expect(data.payload.activeRuns).toBe(0);
  });

  test("--idle-timeout is reflected in browsers", async () => {
    const r = await cli.run([...H, "--idle-timeout", "0", "-e", "1"]);
    expect(r.code).toBe(0);
    const b = await cli.run(["browsers"]);
    expect(b.stdout).toMatch(/idle \d+s\n$/); // no "/30m" suffix when disabled
    await cli.run([...H, "--idle-timeout", "30m", "-e", "1"]);
  });

  test("idle reaper closes a launched browser after --idle-timeout", async () => {
    const r = await cli.run([...H, "--browser", "reap", "--idle-timeout", "1s", "-e", "1"]);
    expect(r.code).toBe(0);
    let b = await cli.run(["browsers"]);
    expect(b.stdout).toMatch(/reap:headless  headless  connected  \d+ page\(s\)  idle \d+s\/1s/);
    const end = Date.now() + 8000;
    do {
      await sleep(400);
      b = await cli.run(["browsers"]);
    } while (b.stdout.includes("reap:headless") && Date.now() < end);
    expect(b.stdout).not.toContain("reap:headless");
    expect(fs.readFileSync(path.join(cli.home, "daemon.log"), "utf8")).toMatch(/idle reaper closing reap:headless/);
  });

  test("a second profile name is a separate browser; stop NAME stops only it", async () => {
    const r = await cli.run([...H, "--browser", "work", "-e", "(await browser.getPage('w')).url()"]);
    expect(r).toEqual({ code: 0, stdout: "about:blank\n", stderr: "" });
    const b = await cli.run(["browsers"]);
    expect(b.stdout.trim().split("\n").length).toBe(2);
    expect(b.stdout).toContain("work:headless  headless");
    expect(fs.existsSync(path.join(cli.home, "browsers", "work", "profile"))).toBe(true);
    const s = await cli.run(["stop", "work"]);
    expect(s).toEqual({ code: 0, stdout: "stopped 1 browser(s)\n", stderr: "" });
    const b2 = await cli.run(["browsers"]);
    expect(b2.stdout.trim().split("\n").length).toBe(1);
    expect(b2.stdout).not.toContain("work");
    const s2 = await cli.run(["stop", "work"]);
    expect(s2.code).toBe(1);
    expect(s2.stdout).toBe('no browser named "work" is running\n');
  });

  test("stop default -> browsers says none; names file survives; getPage recreates", async () => {
    const r = await cli.run(H, {
      stdin: `const p = await browser.getPage("surv")\nawait p.goto(${JSON.stringify(srv.url("/"))})\nawait p.title()`,
    });
    expect(r).toEqual({ code: 0, stdout: "Life\n", stderr: "" });
    const pagesFile = path.join(cli.home, "pages", "default__headless.json");
    expect(JSON.parse(fs.readFileSync(pagesFile, "utf8")).surv).toBeDefined();

    const s = await cli.run(["stop", "default"]);
    expect(s).toEqual({ code: 0, stdout: "stopped 1 browser(s)\n", stderr: "" });
    const b = await cli.run(["browsers"]);
    expect(b).toEqual({ code: 0, stdout: "no browsers running\n", stderr: "" });
    const p = await cli.run(["pages"]);
    expect(p).toEqual({ code: 0, stdout: "no browsers running\n", stderr: "" });
    // daemon is still alive
    const pid = Number(fs.readFileSync(path.join(cli.home, "daemon.pid"), "utf8"));
    expect(pidAlive(pid)).toBe(true);
    // the names file still exists (Chrome died with stop, so the target is gone)
    expect(fs.existsSync(pagesFile)).toBe(true);
    // a fresh getPage recreates the page under the same name (blank), and the map is updated
    const r2 = await cli.run([...H, "-e", `const p = await browser.getPage("surv"); p.url()`]);
    expect(r2).toEqual({ code: 0, stdout: "about:blank\n", stderr: "" });
    const map = JSON.parse(fs.readFileSync(pagesFile, "utf8"));
    expect(map.surv).toMatch(/^[0-9A-F]{32}$/);
  });

  test("killing the daemon with SIGTERM: next run spawns a fresh daemon", async () => {
    const pidFile = path.join(cli.home, "daemon.pid");
    const oldPid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(pidAlive(oldPid)).toBe(true);
    process.kill(oldPid, "SIGTERM");
    expect(await waitFor(() => !pidAlive(oldPid), 10_000)).toBe(true);
    // clean shutdown removes socket + pid file
    expect(fs.existsSync(path.join(cli.home, "daemon.sock"))).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(false);
    const r = await cli.run([...H, "-e", "'reborn'"]);
    expect(r).toEqual({ code: 0, stdout: "reborn\n", stderr: "" });
    const newPid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(newPid).not.toBe(oldPid);
    expect(pidAlive(newPid)).toBe(true);
  });

  test("SIGKILLed daemon leaves a stale socket; the client recovers", async () => {
    const pidFile = path.join(cli.home, "daemon.pid");
    const oldPid = Number(fs.readFileSync(pidFile, "utf8"));
    process.kill(oldPid, "SIGKILL");
    expect(await waitFor(() => !pidAlive(oldPid), 10_000)).toBe(true);
    expect(fs.existsSync(path.join(cli.home, "daemon.sock"))).toBe(true); // stale
    // Chrome is orphaned (still holds the profile lock); the new daemon must reclaim the profile.
    const r = await cli.run([...H, "-e", "(await browser.getPage('after-kill')).url()"]);
    expect(r).toEqual({ code: 0, stdout: "about:blank\n", stderr: "" });
    expect(Number(fs.readFileSync(pidFile, "utf8"))).not.toBe(oldPid);
    expect(fs.readFileSync(path.join(cli.home, "daemon.log"), "utf8")).toMatch(/killing orphan Chrome/);
  });

  test("stop with no name stops everything and the daemon; auto-restarts on the next call", async () => {
    const pidFile = path.join(cli.home, "daemon.pid");
    const oldPid = Number(fs.readFileSync(pidFile, "utf8"));
    const s = await cli.run(["stop"]);
    expect(s.code).toBe(0);
    expect(s.stdout).toMatch(/^stopped \d+ browser\(s\) and the daemon\n$/);
    expect(await waitFor(() => !pidAlive(oldPid), 10_000)).toBe(true);
    const r = await cli.run(["status"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("browsers 0");
  });

  test("concurrent cold start: parallel clients share one daemon", async () => {
    await cli.run(["stop"]);
    await sleep(300);
    const rs = await Promise.all([1, 2, 3, 4].map((n) => cli.run([...H, "-e", `${n}`])));
    for (const [i, r] of rs.entries()) expect(r).toEqual({ code: 0, stdout: `${i + 1}\n`, stderr: "" });
    const log = fs.readFileSync(path.join(cli.home, "daemon.log"), "utf8");
    // only one browser launch for all four
    const s = await cli.run(["browsers"]);
    expect(s.stdout.trim().split("\n").length).toBe(1);
    expect(log).toMatch(/listening on/);
  });
});

describe("hung scripts", () => {
  test("a finite busy loop past the deadline still returns; the daemon stays healthy", async () => {
    const r = await cli.run([...H, "--timeout", "1", "-e", "const t = Date.now(); let i = 0; while (Date.now() - t < 2000) i++; 'done'"]);
    // the event loop was blocked so the deadline timer could not fire first; the value wins
    expect(r.code === 0 || r.code === 124).toBe(true);
    const s = await cli.run(["status"]);
    expect(s.stdout).toContain("runs     0 active");
  });

  test("an infinite loop: the client watchdog kills the hung daemon; the next call restarts it", async () => {
    const pid = Number(fs.readFileSync(path.join(cli.home, "daemon.pid"), "utf8"));
    const t0 = Date.now();
    const r = await cli.run([...H, "--timeout", "1", "-e", "while (true) {}"], { timeoutMs: 40_000 });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no response from daemon for 16s; killed the hung daemon/);
    expect(Date.now() - t0).toBeLessThan(25_000);
    expect(await waitFor(() => !pidAlive(pid), 5000)).toBe(true);
    const r2 = await cli.run([...H, "-e", "'back'"]);
    expect(r2).toEqual({ code: 0, stdout: "back\n", stderr: "" });
    expect(Number(fs.readFileSync(path.join(cli.home, "daemon.pid"), "utf8"))).not.toBe(pid);
  }, 45_000);
});

describe("protocol: version handshake", () => {
  test("daemon answers a mismatched hello with a version error and honors shutdown", async () => {
    await cli.run(["status"]); // make sure a daemon is up
    const sockPath = path.join(cli.home, "daemon.sock");
    const pid = Number(fs.readFileSync(path.join(cli.home, "daemon.pid"), "utf8"));
    const frames: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(sockPath);
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) frames.push(JSON.parse(line));
        }
        if (frames.some((f) => f.type === "done") && frames.length === 3) {
          sock.write(JSON.stringify({ type: "shutdown" }) + "\n");
        }
      });
      sock.on("end", () => sock.end());
      sock.on("close", () => resolve());
      sock.on("error", reject);
      sock.write(JSON.stringify({ type: "hello", version: "0.0.0-test", protocol: 1 }) + "\n");
      sock.write(JSON.stringify({ type: "status" }) + "\n");
      setTimeout(() => {
        sock.destroy();
        reject(new Error("timeout"));
      }, 10_000);
    });
    expect(frames[0]).toMatchObject({ type: "hello", version: VERSION, protocol: 1, pid });
    expect(frames[1]).toMatchObject({ type: "error", kind: "version", name: "VersionMismatch", daemonVersion: VERSION });
    expect((frames[1] as { message: string }).message).toContain("0.0.0-test");
    expect(frames[2]).toMatchObject({ type: "done", exitCode: 1 });
    // the status request after a mismatched hello must not have been served
    expect(frames.some((f) => f.type === "data")).toBe(false);
    expect(await waitFor(() => !pidAlive(pid), 10_000)).toBe(true);
    // a normal client transparently gets a fresh daemon
    const r = await cli.run(["status"]);
    expect(r.code).toBe(0);
    expect(Number(fs.readFileSync(path.join(cli.home, "daemon.pid"), "utf8"))).not.toBe(pid);
  });

  test("hello frame is the first line; a bad first frame yields a protocol error", async () => {
    await cli.run(["status"]);
    const sockPath = path.join(cli.home, "daemon.sock");
    const frames: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(sockPath);
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) frames.push(JSON.parse(line));
        }
      });
      sock.on("end", () => sock.end());
      sock.on("close", () => resolve());
      sock.on("error", reject);
      sock.write("this is not json\n");
      setTimeout(() => {
        sock.destroy();
        reject(new Error("timeout"));
      }, 10_000);
    });
    expect(frames.some((f) => f.type === "error" && f.name === "ProtocolError")).toBe(true);
    expect(frames[frames.length - 1]).toMatchObject({ type: "done", exitCode: 1 });
  });
});

describe("client: version mismatch recovery", () => {
  test("an old daemon is asked to exit and the request is retried on a fresh one", async () => {
    await cli.run(["stop"]);
    const sockPath = path.join(cli.home, "daemon.sock");
    expect(await waitFor(() => !fs.existsSync(sockPath), 10_000)).toBe(true);
    // Fake "old daemon": speaks the protocol but with another version.
    const seen: string[] = [];
    const fake = net.createServer((sock) => {
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as { type: string };
          seen.push(msg.type);
          if (msg.type === "hello") {
            sock.write(JSON.stringify({ type: "hello", version: "0.0.1-old", protocol: 1, pid: process.pid }) + "\n");
            sock.write(JSON.stringify({ type: "error", kind: "version", name: "VersionMismatch", message: "old", daemonVersion: "0.0.1-old" }) + "\n");
            sock.write(JSON.stringify({ type: "done", exitCode: 1, durationMs: 0 }) + "\n");
          } else if (msg.type === "shutdown") {
            sock.write(JSON.stringify({ type: "done", exitCode: 0, durationMs: 0 }) + "\n");
            sock.end();
            fake.close();
            try {
              fs.unlinkSync(sockPath);
            } catch {
              /* ignore */
            }
          } else {
            // a run request must NOT be served by the old daemon; we answer with garbage output to detect it
            sock.write(JSON.stringify({ type: "stdout", data: "FROM OLD DAEMON\n" }) + "\n");
          }
        }
      });
    });
    await new Promise<void>((resolve) => fake.listen(sockPath, resolve));
    try {
      const r = await cli.run([...H, "-e", "'fresh'"]);
      expect(r).toEqual({ code: 0, stdout: "fresh\n", stderr: "" });
      expect(seen[0]).toBe("hello");
      expect(seen).toContain("shutdown");
      const pid = Number(fs.readFileSync(path.join(cli.home, "daemon.pid"), "utf8"));
      expect(pidAlive(pid)).toBe(true);
    } finally {
      fake.close();
    }
  });
});

describe("--connect to an existing Chrome", () => {
  let ext: Browser | null = null;
  let port = 0;
  let userDataDir = "";

  beforeAll(async () => {
    const chrome = findChrome();
    if (!chrome) throw new Error("no Chrome");
    port = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "doobie-ext-chrome-"));
    ext = await puppeteer.launch({
      executablePath: chrome.path,
      headless: true,
      args: ["--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`],
    });
    const page = await ext.newPage();
    await page.goto(srv.url("/"));
    await cli.run(["stop", "default"]); // only the cdp entry should be listed below
  });

  afterAll(async () => {
    await cli.run(["stop"]).catch(() => {});
    if (ext) await ext.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test("--connect PORT", async () => {
    const r = await cli.run(["--connect", String(port), "-e", `const p = await browser.getPage("x"); await p.goto(${JSON.stringify(srv.url("/"))}); await p.title()`]);
    expect(r).toEqual({ code: 0, stdout: "Life\n", stderr: "" });
    const b = await cli.run(["browsers"]);
    // the key is canonicalized to the resolved ws endpoint so that "9222", "http://..." and "auto" share one entry
    expect(b.stdout).toMatch(new RegExp(`^cdp:ws://127\\.0\\.0\\.1:${port}/devtools/browser/[-0-9a-f]+  cdp  connected  \\d+ page\\(s\\)  idle \\d+s\\n$`));
  });

  test("--connect http://127.0.0.1:PORT reaches the same browser and the same named page", async () => {
    const r = await cli.run(["--connect", `http://127.0.0.1:${port}`, "-e", `const p = await browser.getPage("x"); await p.title()`]);
    expect(r).toEqual({ code: 0, stdout: "Life\n", stderr: "" });
    const b = await cli.run(["browsers"]);
    expect(b.stdout.trim().split("\n").length).toBe(1);
    // the external Chrome sees exactly one extra tab named by doobie (plus its own initial + /test page)
    const urls = (await ext!.pages()).map((p) => p.url());
    expect(urls.filter((u) => u === srv.url("/")).length).toBe(2);
  });

  test("--connect auto finds it via the remembered chrome-ports.json", async () => {
    fs.writeFileSync(path.join(cli.home, "chrome-ports.json"), JSON.stringify({ t: { port, pid: 0, profile: "x", at: Date.now() } }));
    const r = await cli.run(["--connect", "-e", `const p = await browser.getPage("x"); await p.title()`]);
    expect(r).toEqual({ code: 0, stdout: "Life\n", stderr: "" });
    const b = await cli.run(["browsers"]);
    expect(b.stdout.trim().split("\n").length).toBe(1);
  });

  test("doobie pages --connect lists the external Chrome's tabs", async () => {
    const r = await cli.run(["pages", "--connect", String(port)]);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[0]).toMatch(new RegExp(`^cdp:ws://127\\.0\\.0\\.1:${port}/devtools/browser/[-0-9a-f]+:$`));
    expect(r.stdout).toContain(`  x  ${srv.url("/")}  "Life"`);
  });

  test("stop by cdp key disconnects without killing Chrome", async () => {
    const s = await cli.run(["stop", `cdp:${port}`]);
    expect(s).toEqual({ code: 0, stdout: "stopped 1 browser(s)\n", stderr: "" });
    expect(ext!.connected).toBe(true);
    expect((await ext!.pages()).length).toBeGreaterThan(0);
  });

  test("--connect to a dead port is a clean error", async () => {
    const r = await cli.run(["--connect", "http://127.0.0.1:1", "-e", "1"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^CdpConnectError: Could not read http:\/\/127\.0\.0\.1:1\/json\/version/);
    expect(r.stdout).toBe("");
  });
});
