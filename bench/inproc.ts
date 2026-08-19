/**
 * Micro-harness: daemon-internal cost of runScript("1+1") without the socket
 * or client process. Compare against `1+1` in bench/run.ts to see the
 * client-vs-daemon split.
 *
 *   bun run bench/inproc.ts [--runs N]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "doobie-inproc-"));
process.env.DOOBIE_HOME = home;

const { runScript } = await import("../src/daemon/run.ts");
const { BrowserManager } = await import("../src/daemon/browsers.ts");
const { FileLogger } = await import("../src/shared/log.ts");
const { ensureHome, paths } = await import("../src/shared/paths.ts");
const { VERSION } = await import("../src/shared/version.ts");
import type { Frame, RunRequest } from "../src/shared/protocol.ts";

const runsArg = process.argv.indexOf("--runs");
const RUNS = runsArg >= 0 ? Math.max(1, Number(process.argv[runsArg + 1]) || 50) : 50;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

ensureHome();
const log = new FileLogger(paths.log());
const manager = new BrowserManager(log);
const frames: Frame[] = [];
const emit = (f: Frame) => {
  frames.push(f);
};

const req = (script: string, id: string): RunRequest => ({
  type: "run",
  id,
  script,
  scriptName: "<bench>",
  source: { kind: "launch", name: "bench", headless: true },
  timeoutMs: 30_000,
  idleTimeoutMs: 0,
  quietPage: true,
  cwd: process.cwd(),
});

let code = 1;
try {
  const ctx = { manager, log, emit, signal: new AbortController().signal };
  const t0 = performance.now();
  const warm = await runScript(req("1+1", "warm"), ctx);
  const launchMs = performance.now() - t0;
  if (warm.exitCode !== 0) throw new Error(`warm-up failed: ${JSON.stringify(frames)}`);
  // second warm run so JIT/vm caches are hot
  await runScript(req("1+1", "warm2"), ctx);

  const xs: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    frames.length = 0;
    const t = performance.now();
    const out = await runScript(req("1+1", `r${i}`), ctx);
    xs.push(performance.now() - t);
    if (out.exitCode !== 0) throw new Error(`run ${i} failed: ${JSON.stringify(frames)}`);
  }
  const ys: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    await runScript(req('const p = await browser.getPage("bench"); await p.title()', `t${i}`), ctx);
    ys.push(performance.now() - t);
  }
  console.log(`doobie ${VERSION} in-process runScript (no socket, no client), ${RUNS} runs`);
  console.log(`first run incl. Chrome launch: ${launchMs.toFixed(0)} ms`);
  console.log(`1+1:            median ${median(xs).toFixed(3)} ms  min ${Math.min(...xs).toFixed(3)} ms`);
  console.log(`getPage+title:  median ${median(ys).toFixed(3)} ms  min ${Math.min(...ys).toFixed(3)} ms`);
  code = 0;
} catch (e) {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  await manager.stopAll().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(code);
