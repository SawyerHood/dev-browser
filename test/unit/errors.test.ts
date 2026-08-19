import { test, expect, describe } from "bun:test";
import { cleanStack, formatScriptError } from "../../src/daemon/errors.ts";

describe("cleanStack", () => {
  const stack = [
    "TypeError: boom",
    "    at <anonymous> (<stdin>:3:9)",
    "    at helper (<stdin>:7:3)",
    "    at async Object.<anonymous> (<stdin>:9:1)",
    "    at /home/u/proj/src/daemon/run.ts:200:10",
    "    at node:internal/process/task_queues:95:5",
    "    at runInContext (unknown)",
  ].join("\n");

  test("keeps only script frames, strips anonymous names", () => {
    const out = cleanStack(stack, "<stdin>", "boom");
    expect(out).toBe(["    at <stdin>:3:9", "    at helper (<stdin>:7:3)", "    at <stdin>:9:1"].join("\n"));
  });

  test("max 5 frames", () => {
    const many = ["Error: x", ...Array.from({ length: 12 }, (_, i) => `    at <anonymous> (<stdin>:${i + 1}:1)`)].join("\n");
    const out = cleanStack(many, "<stdin>", "x")!;
    expect(out.split("\n").length).toBe(5);
    expect(out.split("\n")[4]).toBe("    at <stdin>:5:1");
  });

  test("no script frames -> undefined", () => {
    expect(cleanStack("Error: x\n    at foo (/x/y.js:1:1)", "<stdin>", "x")).toBeUndefined();
  });

  test("script names with regex chars are matched literally", () => {
    const s = "Error: x\n    at <anonymous> (my.script(1).js:2:3)";
    expect(cleanStack(s, "my.script(1).js", "x")).toBe("    at my.script(1).js:2:3");
    expect(cleanStack(s, "my.scriptX1).js", "x")).toBeUndefined();
  });

  test("multi-line message header is skipped", () => {
    const s = "Error: line one\nline two\n    at <anonymous> (<stdin>:1:1)";
    expect(cleanStack(s, "<stdin>", "line one\nline two")).toBe("    at <stdin>:1:1");
  });

  test("line1ColumnShift adjusts columns on line 1 only", () => {
    const s = "Error: x\n    at <anonymous> (<stdin>:1:20)\n    at <anonymous> (<stdin>:2:20)";
    expect(cleanStack(s, "<stdin>", "x", { line1ColumnShift: 14 })).toBe("    at <stdin>:1:6\n    at <stdin>:2:20");
  });

  test("frames without parentheses", () => {
    const s = "Error: x\n    at <stdin>:4:2";
    expect(cleanStack(s, "<stdin>", "x")).toBe("    at <stdin>:4:2");
  });
});

describe("formatScriptError", () => {
  test("Error objects", () => {
    const e = new RangeError("bad range");
    const f = formatScriptError(e, "<stdin>");
    expect(f.name).toBe("RangeError");
    expect(f.message).toBe("bad range");
  });

  test("thrown primitives", () => {
    expect(formatScriptError("oops", "<stdin>")).toEqual({ name: "Error", message: "oops" });
    expect(formatScriptError(42, "<stdin>")).toEqual({ name: "Error", message: "42" });
    expect(formatScriptError(null, "<stdin>")).toEqual({ name: "Error", message: "null" });
    expect(formatScriptError(undefined, "<stdin>")).toEqual({ name: "Error", message: "undefined" });
  });

  test("object with empty name falls back to Error", () => {
    const f = formatScriptError({ name: "", message: "m" }, "<stdin>");
    expect(f.name).toBe("Error");
    expect(f.message).toBe("m");
    expect(f.stack).toBeUndefined();
  });
});

describe("cleanStack columnShifts", () => {
  test("per-line shifts (wrapper on line 1, return( on the last statement's line)", () => {
    const s = "Error: x\n    at <anonymous> (<stdin>:1:20)\n    at <anonymous> (<stdin>:3:10)\n    at <anonymous> (<stdin>:2:10)";
    expect(cleanStack(s, "<stdin>", "x", { columnShifts: { 1: 14, 3: 8 } })).toBe(
      "    at <stdin>:1:6\n    at <stdin>:3:2\n    at <stdin>:2:10",
    );
  });
});
