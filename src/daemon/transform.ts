/**
 * Turn a script body into an async function source.
 *
 * - Parses with acorn (module goal: top-level await allowed, `return` allowed).
 * - If the last top-level statement is an expression, it becomes the return
 *   value. `return` statements written by the user keep working.
 * - Never evaluates the code twice: syntax errors surface here, before run.
 * - Line numbers are preserved (edits stay on the original line).
 */
import { parse, type Node } from "acorn";

export interface TransformResult {
  /** Source of an async arrow function expression: `(async () => { ... })` */
  code: string;
  /** Pass to vm as lineOffset so stack lines match the user's script. */
  lineOffset: number;
  /** Columns reported on line 1 are shifted right by this many chars (the wrapper prefix). */
  line1ColumnShift: number;
  /** Per-line column shifts introduced by the transform (line 1 wrapper, `return (` on the last statement's line). */
  columnShifts: Record<number, number>;
}

/**
 * The wrapper shares line 1 with the user's first line (instead of adding a
 * line and passing lineOffset -1) because Bun's vm ignores negative offsets.
 */
export const WRAPPER_PREFIX = "(async () => {";
const RETURN_PREFIX = "return (";

export class ScriptSyntaxError extends SyntaxError {
  constructor(message: string, readonly line?: number, readonly column?: number) {
    super(message);
    this.name = "SyntaxError";
  }
}

interface AcornError extends Error {
  loc?: { line: number; column: number };
  raisedAt?: number;
}

interface ProgramNode extends Node {
  body: Array<Node & { type: string; expression?: Node; directive?: string }>;
}

export function transformScript(src: string): TransformResult {
  // vm does not accept a hashbang; acorn does. Same length, so positions hold.
  if (src.startsWith("#!")) src = "//" + src.slice(2);
  let program: ProgramNode;
  try {
    program = parse(src, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowHashBang: true,
      locations: true,
    }) as unknown as ProgramNode;
  } catch (err) {
    const e = err as AcornError;
    const line = e.loc?.line;
    const col = e.loc?.column;
    const msg = e.message.replace(/\s*\(\d+:\d+\)\s*$/, "");
    throw new ScriptSyntaxError(line ? `${msg} (line ${line}, column ${(col ?? 0) + 1})` : msg, line, col);
  }

  let body = src;
  const columnShifts: Record<number, number> = { 1: WRAPPER_PREFIX.length };
  const last = program.body[program.body.length - 1];
  // A lone string literal parses as a directive ("use strict"); still return it
  // unless it really is "use strict" (e.g. `doobie -e '"hello"'` prints hello).
  if (last && last.type === "ExpressionStatement" && last.expression && last.directive !== "use strict") {
    const expr = last.expression;
    const exprText = src.slice(expr.start, expr.end);
    body = src.slice(0, last.start) + RETURN_PREFIX + exprText + "\n);" + src.slice(last.end);
    const line = (last as Node & { loc?: { start: { line: number } } }).loc?.start.line ?? 1;
    columnShifts[line] = (columnShifts[line] ?? 0) + RETURN_PREFIX.length;
  }
  // Imports cannot live inside a function body; explain instead of a cryptic error.
  for (const stmt of program.body) {
    if (stmt.type === "ImportDeclaration" || stmt.type.startsWith("Export")) {
      throw new ScriptSyntaxError(
        "import/export are not available in doobie scripts. Everything you need is already in scope (browser, console, saveFile, readFile).",
        (stmt as Node & { loc?: { start: { line: number } } }).loc?.start.line,
      );
    }
  }
  return { code: WRAPPER_PREFIX + body + "\n})", lineOffset: 0, line1ColumnShift: WRAPPER_PREFIX.length, columnShifts };
}
