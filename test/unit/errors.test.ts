import { test, expect, describe } from "bun:test";
import { cleanStack, formatScriptError, adjustColumn } from "../../src/daemon/errors.ts";

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

describe("formatScriptError cause", () => {
  test("appends err.cause's message when it adds information", () => {
    const e = new Error("Waiting for selector `#x` failed", { cause: new Error("Waiting failed: 5000ms exceeded") });
    expect(formatScriptError(e, "<stdin>").message).toBe("Waiting for selector `#x` failed (cause: Waiting failed: 5000ms exceeded)");
  });
  test("string causes work; a cause already contained in the message is not repeated", () => {
    expect(formatScriptError(new Error("boom", { cause: "disk full" }), "<stdin>").message).toBe("boom (cause: disk full)");
    expect(formatScriptError(new Error("boom: disk full", { cause: new Error("disk full") }), "<stdin>").message).toBe("boom: disk full");
    expect(formatScriptError(new Error("plain"), "<stdin>").message).toBe("plain");
  });
  test("stack header is still recognised after the cause is appended", () => {
    const e = new Error("m", { cause: new Error("c") });
    e.stack = "Error: m\n    at <anonymous> (<stdin>:2:3)";
    expect(formatScriptError(e, "<stdin>").stack).toBe("    at <stdin>:2:3");
  });
});

describe("cleanStack returnInsert", () => {
  // source: `const f = () => { throw new Error('x') }; f()` -> transform inserts `return (` at column 42 (0-based)
  const opts = { columnShifts: { 1: 14 + 8 }, returnInsert: { line: 1, column: 42, length: 8 } };
  test("frames before the insertion point are only shifted by the wrapper", () => {
    // raw column 14 (wrapper) + 18 + 1 -> user column 19
    expect(adjustColumn(1, 14 + 19, opts)).toBe(19);
  });
  test("frames after the insertion point are shifted by wrapper + return(", () => {
    // `f()` starts at user column 43 (1-based): raw = 14 + 8 + 43
    expect(adjustColumn(1, 14 + 8 + 43, opts)).toBe(43);
  });
  test("frames inside the inserted text clamp to the insertion point", () => {
    expect(adjustColumn(1, 14 + 42 + 4, opts)).toBe(43);
  });
  test("other lines unaffected; without returnInsert the whole-line shift applies", () => {
    expect(adjustColumn(2, 10, opts)).toBe(10);
    expect(adjustColumn(1, 14 + 19, { columnShifts: { 1: 22 } })).toBe(11);
    const s = "Error: x\n    at <anonymous> (<stdin>:1:33)";
    expect(cleanStack(s, "<stdin>", "x", opts)).toBe("    at <stdin>:1:19");
  });
});
