/**
 * doobie benchmark suite.
 *
 *   bun run bench/run.ts [--check] [--bin PATH|dev] [--runs N]
 *
 * Runs against an isolated DOOBIE_HOME and a warm headless daemon, prints a
 * table of medians vs the targets in docs/design-decisions.md §8, and with
 * --check exits 1 when any measured item misses its target (skips pass).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import puppeteer from "puppeteer-core";
import { startServer, type FixtureServer } from "../test/helpers/server.ts";
import { smallHtml } from "./fixtures/small.ts";
import { serpHtml } from "./fixtures/serp.ts";

/** DOOBIE_BENCH_SCALE multiplies every target (CI runners are slower than a dev box). */
const SCALE = Math.max(1, Number(process.env.DOOBIE_BENCH_SCALE ?? "1") || 1);
const ROOT = path.resolve(import.meta.dir, "..");

interface Opts {
  check: boolean;
  bin?: string;
  runs: number;
}

function parseOpts(argv: string[]): Opts {
  const o: Opts = { check: false, runs: 15 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") o.check = true;
    else if (a === "--bin") o.bin = argv[++i];
    else if (a === "--runs") o.runs = Math.max(1, Number(argv[++i]) || 15);
    else if (a === "-h" || a === "--help") {
      console.log("usage: bun run bench/run.ts [--check] [--bin PATH] [--runs N]");
      process.exit(0);
    } else throw new Error(`unknown arg ${a}`);
  }
  return o;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

interface Row {
  name: string;
  ms: number | null; // null = skipped
  target: number;
  note?: string;
}

function fmt(n: number): string {
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
}

class NotImplemented extends Error {}

async function main(): Promise<void> {
  const opts = parseOpts(process.argv.slice(2));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doobie-bench-"));
  const env: Record<string, string> = { ...(process.env as Record<string, string>), DOOBIE_HOME: home };
  delete env.NODE_PATH;

  const distBin = path.join(ROOT, "dist/doobie");
  const dev = [process.execPath, "run", path.join(ROOT, "src/cli/main.ts")];
  const cmd: string[] =
    opts.bin === "dev" ? dev : opts.bin ? [path.resolve(opts.bin)] : fs.existsSync(distBin) ? [distBin] : dev;
  console.log(`binary: ${cmd.join(" ")}`);
  console.log(`home:   ${home}`);
  console.log(`runs:   ${opts.runs}`);

  interface Res { code: number; stdout: string; stderr: string; ms: number }
  const doobie = async (args: string[], stdin?: string): Promise<Res> => {
    const t0 = performance.now();
    const proc = Bun.spawn([...cmd, ...args], {
      cwd: ROOT,
      env,
      stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 60_000);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { code, stdout, stderr, ms: performance.now() - t0 };
  };

  /** Run a script via --json and return {ms (wall), value (result string)}. Throws on error. */
  const script = async (code: string): Promise<{ ms: number; value: string | undefined }> => {
    const r = await doobie(["--headless", "--json", "--quiet-page", "-e", code]);
    let value: string | undefined;
    let err: string | undefined;
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      let f: { type: string; value?: string; name?: string; message?: string };
      try { f = JSON.parse(line); } catch { continue; }
      if (f.type === "result") value = f.value;
      if (f.type === "error") err = `${f.name}: ${f.message}`;
    }
    if (r.code !== 0 || err) {
      const msg = err ?? `exit ${r.code}: ${r.stderr.trim()}`;
      if (/not implemented/i.test(msg)) throw new NotImplemented(msg);
      throw new Error(`script failed: ${msg}\n--- script ---\n${code}`);
    }
    return { ms: r.ms, value };
  };

  const wall = async (code: string, runs = opts.runs): Promise<number> => {
    const xs: number[] = [];
    for (let i = 0; i < runs; i++) xs.push((await script(code)).ms);
    return median(xs);
  };
  /** The script returns a number measured inside the daemon (ms). */
  const inScript = async (code: string, runs = opts.runs): Promise<number> => {
    const xs: number[] = [];
    for (let i = 0; i < runs; i++) {
      const { value } = await script(code);
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`script did not return a number: ${value}`);
      xs.push(n);
    }
    return median(xs);
  };

  const rows: Row[] = [];
  const measure = async (name: string, target: number, fn: () => Promise<number>, note?: string) => {
    process.stderr.write(`  ${name} ...`);
    try {
      const ms = await fn();
      rows.push({ name, ms, target, note });
      process.stderr.write(` ${fmt(ms)} ms\n`);
    } catch (e) {
      if (e instanceof NotImplemented) {
        rows.push({ name, ms: null, target, note: "not implemented" });
        process.stderr.write(" skipped (not implemented)\n");
      } else throw e;
    }
  };

  let server: FixtureServer | null = null;
  try {
    server = await startServer({ "/small": smallHtml(), "/serp": serpHtml() });

    // warm up: spawns daemon + launches Chrome
    process.stderr.write("warming up daemon ...");
    const w = await script("1+1");
    process.stderr.write(` ${fmt(w.ms)} ms (cold incl. launch)\n`);
    await script("1+1");

    await measure("1+1", 25, () => wall("1+1"), "e2e");
    await measure("getPage+title", 40, () => wall('const p = await browser.getPage("bench"); await p.title()'), "e2e");
    await measure("evaluate(()=>1)", 40, () => wall('const p = await browser.getPage("bench"); await p.evaluate(() => 1)'), "e2e");

    const navigate = async (url: string) => {
      await script(`const p = await browser.getPage("bench"); await p.goto(${JSON.stringify(url)}); await p.title()`);
    };
    await navigate(server.url("/small"));
    await measure(
      "snapshot small",
      30,
      () => inScript('const p = await browser.getPage("bench"); const t = performance.now(); await p.snapshot(); performance.now() - t'),
      "in-script",
    );
    await navigate(server.url("/serp"));
    await measure(
      "snapshot large",
      150,
      () => inScript('const p = await browser.getPage("bench"); const t = performance.now(); await p.snapshot(); performance.now() - t'),
      "in-script",
    );
    await measure(
      "shot viewport",
      120,
      () => inScript('const p = await browser.getPage("bench"); const t = performance.now(); await p.shot(); performance.now() - t'),
      "in-script",
    );

    // per-awaited-call overhead: 50x evaluate in the daemon vs raw puppeteer in-process
    await measure(
      "per-call overhead",
      0.1,
      async () => {
        const N = 50;
        const daemonPerCall = await inScript(
          `const p = await browser.getPage("bench"); const t = performance.now(); for (let i = 0; i < ${N}; i++) await p.evaluate(() => 1); (performance.now() - t) / ${N}`,
        );
        const b = await doobie(["--json", "browsers"]);
        let ws: string | undefined;
        for (const line of b.stdout.split("\n")) {
          if (!line.trim()) continue;
          const f = JSON.parse(line) as { type: string; payload?: Array<{ wsEndpoint?: string; key: string }> };
          if (f.type === "data") ws = f.payload?.find((x) => x.key.endsWith(":headless"))?.wsEndpoint ?? f.payload?.[0]?.wsEndpoint;
        }
        if (!ws) throw new Error(`no wsEndpoint in browsers --json: ${b.stdout}`);
        const browser = await puppeteer.connect({ browserWSEndpoint: ws, protocolTimeout: 30_000 });
        try {
          const page = await browser.newPage();
          await page.goto("about:blank");
          for (let i = 0; i < N; i++) await page.evaluate(() => 1); // warm
          const xs: number[] = [];
          for (let r = 0; r < opts.runs; r++) {
            const t = performance.now();
            for (let i = 0; i < N; i++) await page.evaluate(() => 1);
            xs.push((performance.now() - t) / N);
          }
          await page.close();
          const raw = median(xs);
          process.stderr.write(` [daemon ${fmt(daemonPerCall)} ms/call, raw ${fmt(raw)} ms/call]`);
          return daemonPerCall - raw;
        } finally {
          await browser.disconnect();
        }
      },
      "daemon minus raw",
    );

    // cold start: stop daemon, remove socket, time first 1+1 (daemon spawn + Chrome launch)
    await measure(
      "cold start",
      1500,
      async () => {
        const xs: number[] = [];
        for (let i = 0; i < 3; i++) {
          await doobie(["stop"]);
          await new Promise((r) => setTimeout(r, 300));
          fs.rmSync(path.join(home, "daemon.sock"), { force: true });
          xs.push((await script("1+1")).ms);
        }
        return median(xs);
      },
      "3 runs",
    );
  } finally {
    await server?.stop().catch(() => {});
    try {
      await doobie(["stop"]);
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(home, { recursive: true, force: true });
  }

  // table
  const w1 = Math.max(...rows.map((r) => r.name.length), 4);
  const line = (a: string, b: string, c: string, d: string, e: string) =>
    `${a.padEnd(w1)} | ${b.padStart(9)} | ${c.padStart(9)} | ${d.padEnd(4)} | ${e}`;
  console.log("");
  console.log(line("name", "median ms", "target ms", "", "note"));
  console.log(line("-".repeat(w1), "-".repeat(9), "-".repeat(9), "----", "----"));
  let failed = 0;
  for (const r of rows) {
    if (r.ms === null) {
      console.log(line(r.name, "skipped", fmt(r.target), "pass", r.note ?? ""));
      continue;
    }
    const ok = r.ms <= r.target * SCALE;
    if (!ok) failed++;
    console.log(line(r.name, fmt(r.ms), fmt(r.target), ok ? "pass" : "FAIL", r.note ?? ""));
  }
  console.log("");
  if (SCALE !== 1) console.log(`(targets scaled x${SCALE} via DOOBIE_BENCH_SCALE)`);
  if (failed > 0) console.log(`${failed} item(s) over target`);
  if (opts.check && failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
