/**
 * `doobie chrome` launch verification: a Chrome that dies right away is an
 * error (stderr tail, exit 1, no port recorded); the Linux sandbox failure is
 * retried once with --no-sandbox and remembered; a real headless Chrome is
 * verified via /json/version before success is printed; `--headless` passes
 * --headless=new through.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { findChrome } from "../../src/shared/chrome.ts";
import { makeCliEnv, type CliEnv } from "../helpers/cli.ts";

let home: string;
let prevHome: string | undefined;
let cli: CliEnv;
const ROOT = path.resolve(import.meta.dir, "../..");

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

async function chrome(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  // Import chrome.ts directly (no daemon bundle) in a child process so stdout/stderr are captured.
  const runner = path.join(home, "run-chrome.ts");
  fs.writeFileSync(
    runner,
    `import { chromeCommand } from ${JSON.stringify(path.join(ROOT, "src/cli/commands/chrome.ts"))};\nprocess.exit(await chromeCommand(process.argv.slice(2)));\n`,
  );
  const proc = Bun.spawn([process.execPath, runner, ...args], {
    cwd: ROOT,
    env: { ...process.env, DOOBIE_HOME: home, NODE_PATH: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "doobie-chrome-cmd-"));
  prevHome = process.env.DOOBIE_HOME;
  process.env.DOOBIE_HOME = home;
  cli = makeCliEnv("doobie-chrome-cli-");
});
afterAll(async () => {
  if (prevHome === undefined) delete process.env.DOOBIE_HOME;
  else process.env.DOOBIE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  await cli.cleanup();
});

/** A fake "chrome": prints `msg` to stderr and exits with `code`. */
function fakeChromeDies(name: string, msg: string, code = 1): string {
  const p = path.join(home, name);
  fs.writeFileSync(p, `#!/bin/sh\necho ${JSON.stringify(msg)} >&2\nexit ${code}\n`, { mode: 0o755 });
  return p;
}

/**
 * A fake "chrome" that dies with the sandbox error unless --no-sandbox is
 * given, in which case it serves /json/version on the requested port.
 */
function fakeChromeSandbox(name: string): string {
  const js = path.join(home, name + ".js");
  fs.writeFileSync(
    js,
    `const args = process.argv.slice(2);
if (!args.includes("--no-sandbox")) { console.error("[1:1:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! ... try using --no-sandbox."); process.exit(1); }
const port = Number((args.find(a => a.startsWith("--remote-debugging-port=")) || "").split("=")[1]);
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args));
Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response(JSON.stringify({ Browser: "Fake/1" }), { headers: { "content-type": "application/json" } }) });
setTimeout(() => process.exit(0), 20000);
`,
  );
  const p = path.join(home, name);
  fs.writeFileSync(p, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)} "$@"\n`, { mode: 0o755 });
  return p;
}

describe("doobie chrome verifies the launch", () => {
  test("a Chrome that exits immediately: exit 1, stderr tail shown, no port recorded", async () => {
    const exe = fakeChromeDies("chrome-dies", "Missing X server or DISPLAY", 1);
    const port = await freePort();
    const r = await chrome(["--chrome", exe, "--port", String(port)]);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("launched Chrome");
    expect(r.stderr).toMatch(/Chrome exited right after launch \(exit code 1\)/);
    expect(r.stderr).toContain("Missing X server or DISPLAY");
    expect(r.stderr).toMatch(/full log: .*chrome-logs[/\\]chrome\.log/);
    expect(fs.existsSync(path.join(home, "chrome-ports.json"))).toBe(false);
  }, 20_000);

  test("sandbox failure on Linux is retried once with --no-sandbox and remembered", async () => {
    if (os.platform() !== "linux") return;
    const exe = fakeChromeSandbox("chrome-sandbox");
    const port = await freePort();
    const argsFile = path.join(home, "fake-args.json");
    const r = await chrome(["--chrome", exe, "--port", String(port), "--profile", "sb", "--headless"], { FAKE_ARGS_FILE: argsFile });
    expect(r.stderr).toMatch(/sandbox unavailable, retrying with --no-sandbox/);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`launched Chrome \\(pid \\d+\\) on port ${port}`));
    const args = JSON.parse(fs.readFileSync(argsFile, "utf8")) as string[];
    expect(args).toContain("--no-sandbox");
    expect(args).toContain("--headless=new");
    expect(args).toContain(`--remote-debugging-port=${port}`);
    const ports = JSON.parse(fs.readFileSync(path.join(home, "chrome-ports.json"), "utf8"));
    expect(ports.sb.port).toBe(port);
    expect(ports.sb.pid).toBeGreaterThan(1);
    const state = JSON.parse(fs.readFileSync(path.join(home, "launch-state.json"), "utf8"));
    expect(state.noSandbox).toContain(exe);
    // second launch goes straight to --no-sandbox (no retry line)
    const port2 = await freePort();
    const r2 = await chrome(["--chrome", exe, "--port", String(port2), "--profile", "sb2", "--headless"], { FAKE_ARGS_FILE: argsFile + "2" });
    expect(r2.code).toBe(0);
    expect(r2.stderr).not.toMatch(/retrying/);
    expect(JSON.parse(fs.readFileSync(argsFile + "2", "utf8"))).toContain("--no-sandbox");
    for (const p of [ports.sb.pid, JSON.parse(fs.readFileSync(path.join(home, "chrome-ports.json"), "utf8")).sb2.pid]) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }, 30_000);

  test("a real headless Chrome (--headless) answers /json/version before success is printed", async () => {
    const found = findChrome();
    if (!found) throw new Error("no Chrome for tests");
    const port = await freePort();
    const r = await chrome(["--chrome", found.path, "--headless", "--port", String(port), "--profile", "real"]);
    let pid = 0;
    try {
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/launched Chrome \(pid \d+\) on port \d+/);
      expect(r.stdout).not.toContain("not answering yet");
      expect(r.stdout).toContain("--headless=new");
      const ports = JSON.parse(fs.readFileSync(path.join(home, "chrome-ports.json"), "utf8"));
      pid = ports.real.pid;
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      expect(res.ok).toBe(true);
      const v = (await res.json()) as { Browser: string };
      expect(v.Browser).toMatch(/Chrome|Chromium|HeadlessChrome/);
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
  }, 30_000);

  test("launching twice on the same profile is a clear error (ProcessSingleton), not a false success", async () => {
    const found = findChrome();
    if (!found) throw new Error("no Chrome for tests");
    const port = await freePort();
    const r = await chrome(["--chrome", found.path, "--headless", "--port", String(port), "--profile", "twice"]);
    const pid = JSON.parse(fs.readFileSync(path.join(home, "chrome-ports.json"), "utf8")).twice?.pid ?? 0;
    try {
      expect(r.code).toBe(0);
      const port2 = await freePort();
      const r2 = await chrome(["--chrome", found.path, "--headless", "--port", String(port2), "--profile", "twice"]);
      expect(r2.code).toBe(1);
      expect(r2.stderr).toMatch(/Chrome exited right after launch/);
      expect(r2.stderr).toMatch(/ProcessSingleton|SingletonLock/);
      // the recorded port is still the live one
      expect(JSON.parse(fs.readFileSync(path.join(home, "chrome-ports.json"), "utf8")).twice.port).toBe(port);
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
  }, 30_000);

  test("flags: --headless is accepted, unknown flags are usage errors", async () => {
    const r = await chrome(["--bogus"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown flag --bogus/);
  });
});

describe("doobie help <unknown topic>", () => {
  test("exits 2 with the message on stderr; known topics still exit 0", async () => {
    const r = await cli.run(["help", "bogus-topic"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^doobie: No help topic "bogus-topic"\. Topics: .*quickstart/);
    const ok = await cli.run(["help", "quickstart"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout.startsWith("## quickstart")).toBe(true);
    expect(ok.stderr).toBe("");
  });

  test("findTopicText/unknownTopicMessage", async () => {
    const { findTopicText, unknownTopicMessage, topicText } = await import("../../src/cli/help.ts");
    expect(findTopicText("nope")).toBeNull();
    expect(findTopicText("QuickStart")!.startsWith("## quickstart")).toBe(true);
    expect(topicText("nope")).toBe(unknownTopicMessage("nope"));
    expect(unknownTopicMessage("nope")).toMatch(/^No help topic "nope"\. Topics: /);
  });
});
