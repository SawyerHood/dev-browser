/**
 * Run the dev-browser CLI (dev mode) against an isolated DEV_BROWSER_HOME.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { windowsProcessTable } from "../../src/daemon/browsers.ts";

/** fs.existsSync for a socket file, which Windows cannot stat (EACCES). */
export function socketExists(file: string): boolean {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * fs.rmSync for a directory a daemon or its Chrome used. Windows keeps their files locked
 * until they exit, and a Chrome that a test orphaned on purpose never does: kill what still
 * runs from `dir`, then retry for a while (Bun's fs.rmSync ignores maxRetries).
 */
export async function removeDir(dir: string): Promise<void> {
  if (process.platform === "win32") {
    for (const [pid, p] of await windowsProcessTable()) {
      if (pid !== process.pid && p.cmdline.toLowerCase().includes(dir.toLowerCase())) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (process.platform !== "win32" || attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliEnv {
  home: string;
  run(args: string[], opts?: { stdin?: string; timeoutMs?: number; env?: Record<string, string>; cwd?: string }): Promise<CliResult>;
  /** Stop the daemon and delete the home dir. */
  cleanup(): Promise<void>;
}

const ROOT = path.resolve(import.meta.dir, "../..");
const MAIN = path.join(ROOT, "src/cli/main.ts");

export function makeCliEnv(prefix = "dev-browser-test-"): CliEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const baseEnv: Record<string, string> = { ...(process.env as Record<string, string>), DEV_BROWSER_HOME: home };
  delete baseEnv.NODE_PATH;
  const run = async (
    args: string[],
    opts: { stdin?: string; timeoutMs?: number; env?: Record<string, string>; cwd?: string } = {},
  ): Promise<CliResult> => {
    const proc = Bun.spawn([process.execPath, MAIN, ...args], {
      cwd: opts.cwd ?? ROOT,
      env: { ...baseEnv, ...(opts.env ?? {}) },
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { code, stdout, stderr };
  };
  return {
    home,
    run,
    cleanup: async () => {
      try {
        await run(["stop"], { timeoutMs: 15_000 });
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 200));
      await removeDir(home);
    },
  };
}
