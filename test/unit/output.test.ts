import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OutputSink } from "../../src/cli/output.ts";
import { paths } from "../../src/shared/paths.ts";

let home: string;
const prevHome = process.env.DEV_BROWSER_HOME;
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dev-browser-output-"));
  process.env.DEV_BROWSER_HOME = home;
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.DEV_BROWSER_HOME;
  else process.env.DEV_BROWSER_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function makeSink(opts: Partial<ConstructorParameters<typeof OutputSink>[0]> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const sink = new OutputSink({
    cap: true,
    runId: opts.runId ?? "t" + Math.random().toString(36).slice(2),
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    ...opts,
  });
  return { sink, out: () => out.join(""), err: () => err.join("") };
}

describe("OutputSink", () => {
  test("below cap: everything streams through unchanged", () => {
    const { sink, out, err } = makeSink({ capChars: 100, tailChars: 10 });
    sink.write("stdout", "hello\n");
    sink.write("stdout", "world\n");
    sink.write("stderr", "warn\n");
    sink.finish();
    expect(out()).toBe("hello\nworld\n");
    expect(err()).toBe("warn\n");
    expect(fs.existsSync(paths.tmp()) && fs.readdirSync(paths.tmp()).some((f) => f.startsWith("out-"))).toBe(false);
  });

  test("over cap: head streamed, marker + tail printed, spill file has everything", () => {
    const runId = "capped1";
    const { sink, out } = makeSink({ capChars: 100, tailChars: 20, runId });
    const chunks: string[] = [];
    for (let i = 0; i < 30; i++) chunks.push(`line-${String(i).padStart(3, "0")}\n`); // 9 chars each = 270 total
    for (const c of chunks) sink.write("stdout", c);
    const full = chunks.join("");
    const beforeFinish = out();
    // exactly the first 100 chars were streamed live
    expect(beforeFinish).toBe(full.slice(0, 100));
    sink.finish();
    const text = out();
    expect(text).toContain(`[... stdout capped at 100 chars, ${full.length} total`);
    const spill = path.join(paths.tmp(), `out-${runId}.txt`);
    expect(text).toContain(spill);
    expect(text).toContain("sed -n");
    expect(text).toContain("[... last 20 chars ...]\n" + full.slice(-20));
    expect(fs.readFileSync(spill, "utf8")).toBe(full);
  });

  test("one huge write crossing the cap", () => {
    const runId = "capped2";
    const { sink, out } = makeSink({ capChars: 50, tailChars: 5, runId });
    const big = "x".repeat(40) + "y".repeat(40) + "z".repeat(40);
    sink.write("stdout", big);
    expect(out()).toBe(big.slice(0, 50));
    sink.finish();
    expect(out()).toContain("zzzzz\n");
    expect(fs.readFileSync(path.join(paths.tmp(), `out-${runId}.txt`), "utf8")).toBe(big);
  });

  test("stderr is never capped", () => {
    const { sink, err } = makeSink({ capChars: 10, tailChars: 5 });
    const big = "e".repeat(1000);
    sink.write("stderr", big);
    sink.finish();
    expect(err()).toBe(big);
  });

  test("cap disabled: everything streams, no spill, no marker", () => {
    const runId = "nocap1";
    const { sink, out } = makeSink({ cap: false, capChars: 10, tailChars: 5, runId });
    const big = "q".repeat(5000);
    sink.write("stdout", big);
    sink.finish();
    expect(out()).toBe(big);
    expect(fs.existsSync(path.join(paths.tmp(), `out-${runId}.txt`))).toBe(false);
  });

  test("defaults: 50k cap, 5k tail", () => {
    const runId = "defaults1";
    const { sink, out } = makeSink({ runId });
    const big = "a".repeat(120_000);
    sink.write("stdout", big);
    sink.finish();
    const text = out();
    expect(text.startsWith("a".repeat(50_000) + "\n[... stdout capped at 50000 chars, 120000 total")).toBe(true);
    expect(text).toContain("[... last 5000 chars ...]\n" + "a".repeat(5000) + "\n");
  });

  test("finish is a no-op when nothing was capped", () => {
    const { sink, out } = makeSink();
    sink.finish();
    expect(out()).toBe("");
  });
});
