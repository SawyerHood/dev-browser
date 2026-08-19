import { test, expect, describe } from "bun:test";
import * as vm from "node:vm";
import { transformScript, ScriptSyntaxError } from "../../src/daemon/transform.ts";

async function run(src: string, sandbox: Record<string, unknown> = {}): Promise<unknown> {
  const t = transformScript(src);
  const ctx = vm.createContext({ ...sandbox });
  const fn = vm.runInContext(t.code, ctx, { filename: "<stdin>", lineOffset: t.lineOffset }) as () => Promise<unknown>;
  return fn();
}

describe("transformScript", () => {
  test("last expression becomes the return value", async () => {
    expect(await run("1+1")).toBe(2);
  });

  test("trailing semicolon", async () => {
    expect(await run("const a = 2;\na * 3;")).toBe(6);
  });

  test("trailing comment after last expression", async () => {
    expect(await run("const a = 2\na * 3 // comment\n")).toBe(6);
    expect(await run("const a = 2\na * 3\n/* trailing block */")).toBe(6);
  });

  test("multi-line last expression", async () => {
    const v = await run("const x = 1;\n({\n  a: x,\n  b: [1,\n 2]\n})");
    expect(v).toEqual({ a: 1, b: [1, 2] });
  });

  test("multi-line call expression as last statement", async () => {
    const v = await run("function f(a, b) { return a + b }\nf(\n  1,\n  2\n)");
    expect(v).toBe(3);
  });

  test("explicit return works", async () => {
    expect(await run("return 42")).toBe(42);
    expect(await run("if (true) { return 'early' }\n'late'")).toBe("early");
  });

  test("const-only script returns undefined", async () => {
    expect(await run("const a = 1; const b = 2;")).toBeUndefined();
    expect(await run("")).toBeUndefined();
    expect(await run("// only a comment")).toBeUndefined();
  });

  test("lone string literal (a 'directive' to the parser) is still returned", async () => {
    expect(await run("'plain string'")).toBe("plain string");
    expect(await run('"a"\n"b"')).toBe("b");
    // but a real 'use strict' prologue is not the result
    expect(await run("'use strict'")).toBeUndefined();
    expect(await run("'use strict'\n5")).toBe(5);
  });

  test("top-level await", async () => {
    const v = await run("const x = await Promise.resolve(5)\nawait new Promise(r => setTimeout(r, 1))\nx * 2", {
      setTimeout,
    });
    expect(v).toBe(10);
  });

  test("await expression as last statement returns the resolved value", async () => {
    expect(await run("await Promise.resolve('done')")).toBe("done");
  });

  test("never executes twice", async () => {
    const calls: number[] = [];
    await run("tick(1)\ntick(2)", { tick: (n: number) => calls.push(n) });
    expect(calls).toEqual([1, 2]);
  });

  test("syntax error message includes line and column", () => {
    let err: unknown;
    try {
      transformScript("const a = 1\nconst b = ;\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ScriptSyntaxError);
    const e = err as ScriptSyntaxError;
    expect(e.name).toBe("SyntaxError");
    expect(e.line).toBe(2);
    expect(e.message).toMatch(/line 2, column \d+/);
    // acorn's trailing "(2:10)" is stripped in favour of the readable form
    expect(e.message).not.toMatch(/\(\d+:\d+\)$/);
  });

  test("import statement gives a friendly error", () => {
    expect(() => transformScript("import fs from 'fs'\n1")).toThrow(/import\/export are not available/);
    expect(() => transformScript("export const a = 1")).toThrow(/import\/export are not available/);
  });

  test("stack line numbers match the user's script (Bun ignores negative lineOffset)", async () => {
    const t = transformScript("const a = 1\n\nthrow new TypeError('boom')");
    const ctx = vm.createContext({});
    const fn = vm.runInContext(t.code, ctx, { filename: "<stdin>", lineOffset: t.lineOffset }) as () => Promise<unknown>;
    let stack = "";
    try {
      await fn();
    } catch (e) {
      stack = (e as Error).stack ?? "";
    }
    expect(stack).toMatch(/<stdin>:3:\d+/);
  });

  test("hashbang is allowed", async () => {
    expect(await run("#!/usr/bin/env doobie\n7")).toBe(7);
  });

  test("code is an async arrow expression sharing line 1 with the script", () => {
    const t = transformScript("1");
    expect(t.code.startsWith("(async () => {")).toBe(true);
    expect(t.lineOffset).toBe(0);
    expect(t.line1ColumnShift).toBe("(async () => {".length);
    // line count of the wrapped code = user lines + 1 (closing line only)
    const user = "a\nb\nconst c = 1";
    expect(transformScript(user).code.split("\n").length).toBe(user.split("\n").length + 1);
  });
});

describe("transformScript column shifts", () => {
  test("records the wrapper shift on line 1 and the return( shift on the last statement line", () => {
    expect(transformScript("1+1").columnShifts).toEqual({ 1: "(async () => {".length + "return (".length });
    expect(transformScript("const a = 1\na").columnShifts).toEqual({ 1: "(async () => {".length, 2: "return (".length });
    expect(transformScript("const a = 1\nconst b = 2").columnShifts).toEqual({ 1: "(async () => {".length });
  });
});
