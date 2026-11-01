// reclaimProfile must give an orphaned Chrome a graceful quit before SIGKILL:
// Chrome removes its per-launch state (the macOS code-sign clone of the app
// bundle, temp files) only when it exits cleanly. A fake "Chrome" stands in.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reclaimProfile } from "../../src/daemon/browsers.ts";

const TERM_GRACE_MS = 5_000;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const log = { warn() {}, info() {}, error() {}, debug() {} } as unknown as Parameters<typeof reclaimProfile>[2];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function events(file: string): { name: string; at: number }[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, at] = line.split(" ");
      return { name: name ?? "", at: Number(at) };
    });
}

// Starts a fake Chrome whose command line names the profile, through a parent
// that exits at once, so the fake is reparented: an orphan of a dead daemon.
async function orphanChrome(onTerm: "ignore" | "exit"): Promise<{ profile: string; pid: number; log: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-browser-reclaim-"));
  dirs.push(dir);
  const profile = path.join(dir, "profile");
  fs.mkdirSync(profile);
  const eventLog = path.join(dir, "events.log");
  const fake = [
    "const fs = require('node:fs');",
    `process.on('SIGTERM', () => { fs.appendFileSync(${JSON.stringify(eventLog)}, 'TERM ' + Date.now() + '\\n');`,
    onTerm === "exit" ? "process.exit(0);" : "",
    "});",
    `fs.appendFileSync(${JSON.stringify(eventLog)}, 'READY ' + Date.now() + '\\n');`,
    "setInterval(() => {}, 60000);",
  ].join(" ");
  const launcher = [
    "const { spawn } = require('node:child_process');",
    `const c = spawn(process.execPath, ['-e', ${JSON.stringify(fake)}, '--', '--user-data-dir=${profile}'], { detached: true, stdio: 'ignore' });`,
    "console.log(c.pid); c.unref();",
  ].join(" ");
  const out = Bun.spawnSync(["node", "-e", launcher], { stdout: "pipe" });
  const pid = Number(out.stdout.toString().trim());
  const deadline = Date.now() + 5_000;
  while (!events(eventLog).some((e) => e.name === "READY") && Date.now() < deadline) await Bun.sleep(25);
  fs.symlinkSync(`fakehost-${pid}`, path.join(profile, "SingletonLock"));
  return { profile, pid, log: eventLog };
}

describe.skipIf(process.platform === "win32")("reclaimProfile on an orphaned Chrome", () => {
  test("sends SIGTERM and waits the grace window before SIGKILL", async () => {
    const chrome = await orphanChrome("ignore");
    try {
      const outcome = await reclaimProfile(chrome.profile, () => new Set(), log, { waitMs: 0 });
      const freedAt = Date.now();
      expect(outcome).toBe("free");
      const term = events(chrome.log).find((e) => e.name === "TERM");
      expect(term, "orphan never received SIGTERM before being killed").toBeDefined();
      expect(freedAt - (term?.at ?? freedAt)).toBeGreaterThanOrEqual(TERM_GRACE_MS - 500);
      expect(alive(chrome.pid)).toBe(false);
      expect(fs.existsSync(path.join(chrome.profile, "SingletonLock"))).toBe(false);
    } finally {
      if (alive(chrome.pid)) process.kill(chrome.pid, "SIGKILL");
    }
  }, 20_000);

  test("frees the profile as soon as an orphan honours SIGTERM", async () => {
    const chrome = await orphanChrome("exit");
    try {
      const started = Date.now();
      const outcome = await reclaimProfile(chrome.profile, () => new Set(), log, { waitMs: 0 });
      expect(outcome).toBe("free");
      expect(events(chrome.log).some((e) => e.name === "TERM")).toBe(true);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(alive(chrome.pid)).toBe(false);
    } finally {
      if (alive(chrome.pid)) process.kill(chrome.pid, "SIGKILL");
    }
  }, 20_000);
});
