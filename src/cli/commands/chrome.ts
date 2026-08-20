/**
 * doobie chrome [--profile NAME] [--port N] [--chrome PATH] [--headless] [URL]
 *
 * Launch the user's installed Chrome as a normal OS process with remote
 * debugging on a dedicated profile, and remember the port so `doobie --connect`
 * (auto) finds it. This is the path where Google sign-in works.
 *
 * The launch is verified: Chrome must answer /json/version (or at least stay
 * alive) before the port is recorded and success is printed. A Chrome that
 * dies at once (no sandbox, no display, bad binary) is reported with its
 * stderr tail and exit 1; the Linux sandbox failure is retried once with
 * --no-sandbox and remembered like the daemon's launch path does.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { listChromeCandidates, type ChromeCandidate } from "../../shared/chrome.ts";
import { paths, ensureHome } from "../../shared/paths.ts";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "../../shared/protocol.ts";
import { needsNoSandbox, rememberNoSandbox, isSandboxError } from "../../daemon/sources/launch.ts";

/** How long to wait for Chrome to answer /json/version before giving up. */
export const CHROME_READY_MS = 3000;
const POLL_MS = 100;

/**
 * Excerpt of a log for an error message: the first two non-empty lines (Chrome
 * prints the FATAL reason first, then a stack dump) plus the last `n`.
 */
export function tailLines(file: string, n = 6): string {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
    if (lines.length <= n + 2) return lines.join("\n");
    return [...lines.slice(0, 2), "...", ...lines.slice(-n)].join("\n");
  } catch {
    return "";
  }
}

function readAll(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

async function devtoolsAnswers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

type SpawnOutcome =
  | { ok: true; pid: number; answered: boolean }
  /** `stderr` is the tail for display; `fullStderr` the whole log (for error-pattern matching). */
  | { ok: false; exitCode: number | null; signal: string | null; stderr: string; fullStderr: string };

/**
 * Spawn Chrome detached (stderr to `logFile`) and wait until /json/version
 * answers, the child exits, or `readyMs` elapses. A child that is still alive
 * but not answering after the window counts as launched (a slow first start);
 * an exited child is a failure.
 */
export async function spawnAndVerify(
  exe: string,
  args: string[],
  port: number,
  logFile: string,
  readyMs = CHROME_READY_MS,
): Promise<SpawnOutcome> {
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const errFd = fs.openSync(logFile, "w", 0o600);
  let child: ChildProcess;
  try {
    child = spawn(exe, args, { detached: true, stdio: ["ignore", "ignore", errFd] });
  } catch (err) {
    fs.closeSync(errFd);
    return { ok: false, exitCode: null, signal: null, stderr: (err as Error).message, fullStderr: (err as Error).message };
  }
  fs.closeSync(errFd);
  child.unref();
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });
  child.once("error", (err) => {
    exited = { code: null, signal: null };
    fs.appendFileSync(logFile, `${err.message}\n`);
  });
  const died = (): SpawnOutcome => {
    const e = exited as unknown as { code: number | null; signal: NodeJS.Signals | null };
    return { ok: false, exitCode: e.code, signal: e.signal, stderr: tailLines(logFile), fullStderr: readAll(logFile) };
  };
  const end = Date.now() + readyMs;
  for (;;) {
    if (exited) return died();
    if (await devtoolsAnswers(port)) return { ok: true, pid: child.pid ?? 0, answered: true };
    if (Date.now() >= end) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (exited) return died();
  child.removeAllListeners("exit");
  child.removeAllListeners("error");
  child.on("error", () => {});
  return { ok: true, pid: child.pid ?? 0, answered: false };
}

function freePort(start: number): Promise<number> {
  return new Promise((resolve) => {
    const tryPort = (p: number) => {
      const srv = net.createServer();
      srv.once("error", () => tryPort(p + 1));
      srv.listen(p, "127.0.0.1", () => {
        srv.close(() => resolve(p));
      });
    };
    tryPort(start);
  });
}

/**
 * `doobie chrome` exists so Google/OAuth sign-in works, which rejects
 * automation builds. So prefer the user's real browser: system Chrome first,
 * then explicit overrides, and Chrome for Testing / Playwright only as a last
 * resort (with a warning). This is the reverse of findChrome()'s order.
 */
export function pickChromeForUser(candidates: ChromeCandidate[]): ChromeCandidate | null {
  const rank: Record<ChromeCandidate["source"], number> = { system: 0, env: 1, config: 2, installed: 3, playwright: 4 };
  let best: ChromeCandidate | null = null;
  for (const c of candidates) if (!best || rank[c.source] < rank[best.source]) best = c;
  return best;
}

export async function chromeCommand(args: string[]): Promise<number> {
  let profile = "chrome";
  let port: number | undefined;
  let chromePath: string | undefined;
  let url: string | undefined;
  let list = false;
  let headless = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = args[i + 1];
    if (a === "--profile" || a === "-p") {
      if (!next) return usage("--profile requires a name");
      profile = next;
      i++;
    } else if (a === "--port") {
      if (!next) return usage("--port requires a number");
      port = Number(next);
      i++;
    } else if (a === "--chrome") {
      if (!next) return usage("--chrome requires a path");
      chromePath = next;
      i++;
    } else if (a === "--list") {
      list = true;
    } else if (a === "--headless") {
      headless = true;
    } else if (a.startsWith("-")) {
      return usage(`unknown flag ${a}`);
    } else {
      url = a;
    }
  }
  if (list) {
    for (const c of listChromeCandidates()) process.stdout.write(`${c.source.padEnd(10)} ${c.path}\n`);
    return EXIT_OK;
  }
  const picked = chromePath ? { path: chromePath, source: "env" as const } : pickChromeForUser(listChromeCandidates());
  const exe = picked?.path;
  if (!exe || !picked) {
    process.stderr.write("doobie chrome: no Chrome found. Pass --chrome /path/to/chrome or run `doobie install`.\n");
    return EXIT_ERROR;
  }
  if (!chromePath && (picked.source === "installed" || picked.source === "playwright")) {
    process.stderr.write(
      `doobie chrome: no system Chrome found; using ${picked.source === "installed" ? "Chrome for Testing" : "Playwright's Chromium"} (${exe}).\n` +
        "  Google sign-in may reject it. Install Google Chrome or pass --chrome /path/to/chrome.\n",
    );
  }
  ensureHome();
  // Own root (chrome-profiles/NAME), never browsers/NAME/profile: a profile dir
  // can hold one Chrome at a time, and `-b NAME` must stay launchable.
  const userDataDir = paths.chromeProfile(profile);
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) return usage(`--port must be 1..65535, got ${port}`);
  const chosenPort = port ?? (await freePort(9222));
  const chromeArgs = [
    `--remote-debugging-port=${chosenPort}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
  ];
  if (headless) chromeArgs.push("--headless=new");
  const isLinux = os.platform() === "linux";
  const isRoot = isLinux && typeof process.getuid === "function" && process.getuid() === 0;
  let noSandbox = isRoot || needsNoSandbox(exe);
  if (url) chromeArgs.push(url);
  const logFile = path.join(paths.home(), "chrome-logs", `${profile}.log`);
  const launch = () => spawnAndVerify(exe, noSandbox ? [...chromeArgs, "--no-sandbox"] : chromeArgs, chosenPort, logFile);
  let outcome = await launch();
  if (!outcome.ok && !noSandbox && isLinux && isSandboxError(outcome.fullStderr)) {
    process.stderr.write(`doobie chrome: sandbox unavailable, retrying with --no-sandbox (remembered for ${exe})\n`);
    noSandbox = true;
    outcome = await launch();
    if (outcome.ok) rememberNoSandbox(exe);
  }
  if (!outcome.ok) {
    const how = outcome.signal ? `killed by ${outcome.signal}` : `exit code ${outcome.exitCode ?? "?"}`;
    let msg = `doobie chrome: Chrome exited right after launch (${how}).\n  chrome: ${exe}\n`;
    if (outcome.stderr) msg += outcome.stderr.replace(/^/gm, "  | ") + "\n";
    msg += `  full log: ${logFile}\n`;
    if (!headless && isLinux && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      msg += "  hint: no DISPLAY/WAYLAND_DISPLAY is set; a headed Chrome needs a display (try --headless, or xvfb-run).\n";
    }
    process.stderr.write(msg);
    return EXIT_ERROR;
  }
  // remember the port
  let ports: Record<string, { port: number; pid: number; profile: string; at: number }> = {};
  try {
    ports = JSON.parse(fs.readFileSync(paths.chromePorts(), "utf8"));
  } catch {
    /* none yet */
  }
  ports[profile] = { port: chosenPort, pid: outcome.pid, profile: userDataDir, at: Date.now() };
  fs.writeFileSync(paths.chromePorts(), JSON.stringify(ports, null, 2), { mode: 0o600 });
  process.stdout.write(
    `launched Chrome (pid ${outcome.pid}) on port ${chosenPort} with profile ${userDataDir}${outcome.answered ? "" : " (not answering yet; still starting)"}\n` +
      `chrome: ${exe}${chromePath ? "" : ` (${picked.source})`}${noSandbox ? " --no-sandbox" : ""}${headless ? " --headless=new" : ""}\n` +
      `use:  doobie --connect ${chosenPort} -e 'await (await browser.getPage("main")).title()'\n` +
      `or:   doobie --connect   (auto-discovers this port)\n`,
  );
  return EXIT_OK;
}

function usage(msg: string): number {
  process.stderr.write(`doobie chrome: ${msg}\n`);
  return EXIT_USAGE;
}
