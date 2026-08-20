/**
 * Run the doobie CLI (dev mode) against an isolated DOOBIE_HOME.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

export function makeCliEnv(prefix = "doobie-test-"): CliEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const baseEnv: Record<string, string> = { ...(process.env as Record<string, string>), DOOBIE_HOME: home };
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
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
