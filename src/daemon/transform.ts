/**
 * Turn a script body into an async function source.
 *
 * - Parses with acorn (module goal: top-level await allowed, `return` allowed).
 * - If the last top-level statement is an expression, it becomes the return
 *   value. `return` statements written by the user keep working.
 * - A trailing bare object literal (`{ a: 1 }`, which JS parses as a block)
 *   is treated as the return value too, like the Node REPL does.
 * - Never evaluates the code twice: syntax errors surface here, before run.
 * - Line numbers are preserved (edits stay on the original line).
 */
import { parse, type Node } from "acorn";

export interface ReturnInsert {
  /** 1-based line on which `return (` was inserted. */
  line: number;
  /** 0-based column (in the user's source) of the insertion point. */
  column: number;
  /** Number of characters inserted (`return (`.length). */
  length: number;
}

export interface TransformResult {
  /** Source of an async arrow function expression: `(async () => { ... })` */
  code: string;
  /** Pass to vm as lineOffset so stack lines match the user's script. */
  lineOffset: number;
  /** Columns reported on line 1 are shifted right by this many chars (the wrapper prefix). */
  line1ColumnShift: number;
  /** Per-line column shifts introduced by the transform (line 1 wrapper, `return (` on the last statement's line). */
  columnShifts: Record<number, number>;
  /**
   * Where `return (` was inserted, if anywhere. Frames on that line before
   * the insertion point are not shifted by it (see errors.ts cleanStack).
   */
  returnInsert: ReturnInsert | null;
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
  pos?: number;
  raisedAt?: number;
}

type Stmt = Node & { type: string; expression?: Node; directive?: string; body?: unknown; loc?: { start: { line: number; column: number } } };

interface ProgramNode extends Node {
  body: Stmt[];
}

const PARSE_OPTS = {
  ecmaVersion: "latest",
  sourceType: "module",
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowHashBang: true,
  locations: true,
} as const;

function parseProgram(src: string): ProgramNode {
  return parse(src, PARSE_OPTS) as unknown as ProgramNode;
}

function toSyntaxError(err: unknown): ScriptSyntaxError {
  const e = err as AcornError;
  const line = e.loc?.line;
  const col = e.loc?.column;
  const msg = e.message.replace(/\s*\(\d+:\d+\)\s*$/, "");
  return new ScriptSyntaxError(line ? `${msg} (line ${line}, column ${(col ?? 0) + 1})` : msg, line, col);
}

/**
 * Find the trailing top-level `{ ... }` group of `src` (ignoring trailing
 * whitespace, comments and semicolons). Returns [openIndex, closeIndex] or null.
 * Brace matching is naive (strings/comments are not parsed); the caller
 * validates by re-parsing, so a wrong guess only costs a failed retry.
 */
function trailingBraceGroup(src: string): [number, number] | null {
  let end = src.length - 1;
  for (;;) {
    while (end >= 0 && /[\s;]/.test(src[end]!)) end--;
    if (end < 0) return null;
    if (src[end] === "}") break;
    // trailing line comment: back up to just before the `//`
    const lineStart = src.lastIndexOf("\n", end) + 1;
    const lineText = src.slice(lineStart, end + 1);
    const lc = lineText.lastIndexOf("//");
    if (lc >= 0) {
      end = lineStart + lc - 1;
      continue;
    }
    // trailing block comment
    if (end >= 1 && src[end] === "/" && src[end - 1] === "*") {
      const open = src.lastIndexOf("/*", end - 2);
      if (open < 0) return null;
      end = open - 1;
      continue;
    }
    return null;
  }
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    const ch = src[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      depth--;
      if (depth === 0) return [i, end];
    }
  }
  return null;
}

/** If wrapping src[open..close] in parens parses as a trailing object literal, return the parenthesized source's program. */
function tryObjectLiteralRetry(src: string, open: number, close: number): boolean {
  // `;(` rather than `(`: a preceding line ending in an expression would otherwise
  // turn into a call (ASI), which is exactly the trap this retry works around.
  const retry = src.slice(0, open) + ";(" + src.slice(open, close + 1) + ")" + src.slice(close + 1);
  let prog: ProgramNode;
  try {
    prog = parseProgram(retry);
  } catch {
    return false;
  }
  const last = prog.body[prog.body.length - 1];
  if (!last || last.type !== "ExpressionStatement" || !last.expression) return false;
  return last.expression.type === "ObjectExpression" && last.expression.start === open + 2;
}

export function transformScript(src: string): TransformResult {
  // vm does not accept a hashbang; acorn does. Same length, so positions hold.
  if (src.startsWith("#!")) src = "//" + src.slice(2);
  let program: ProgramNode | null = null;
  // [start, end) of an expression to return that is not an ExpressionStatement in `program`
  let objectLiteral: [number, number] | null = null;
  try {
    program = parseProgram(src);
  } catch (err) {
    // `{ url: p.url(), title: await p.title() }` fails to parse as a block:
    // retry once with the trailing brace group parenthesized.
    const e = err as AcornError;
    const group = trailingBraceGroup(src);
    const pos = typeof e.pos === "number" ? e.pos : typeof e.raisedAt === "number" ? e.raisedAt : -1;
    if (group && pos >= group[0] && pos <= group[1] + 1 && tryObjectLiteralRetry(src, group[0], group[1])) {
      objectLiteral = [group[0], group[1] + 1];
      try {
        program = parseProgram(src.slice(0, group[0]) + ";(" + src.slice(group[0], group[1] + 1) + ")" + src.slice(group[1] + 1));
      } catch {
        throw toSyntaxError(err);
      }
    } else {
      throw toSyntaxError(err);
    }
  }

  if (!program) throw new ScriptSyntaxError("could not parse script");

  let body = src;
  const columnShifts: Record<number, number> = { 1: WRAPPER_PREFIX.length };
  let returnInsert: ReturnInsert | null = null;
  const last = program.body[program.body.length - 1];
  // Ranges in the original source: the statement to replace and the expression to return.
  let stmtRange: [number, number] | null = null;
  let exprRange: [number, number] | null = null;
  if (objectLiteral) {
    stmtRange = objectLiteral;
    exprRange = objectLiteral;
  } else if (last && last.type === "ExpressionStatement" && last.expression && last.directive !== "use strict") {
    // A lone string literal parses as a directive ("use strict"); still return it
    // unless it really is "use strict" (e.g. `dev-browser -e '"hello"'` prints hello).
    stmtRange = [last.start, last.end];
    exprRange = [last.expression.start, last.expression.end];
  } else if (last && last.type === "BlockStatement" && isObjectLikeBlock(last) && tryObjectLiteralRetry(src, last.start, last.end - 1)) {
    // `{ a: 1 }` as the last statement is a block with a labeled statement; the
    // author almost certainly meant an object literal (Node REPL behaviour).
    stmtRange = [last.start, last.end];
    exprRange = [last.start, last.end];
  }
  if (stmtRange && exprRange) {
    body = src.slice(0, stmtRange[0]) + RETURN_PREFIX + src.slice(exprRange[0], exprRange[1]) + "\n);" + src.slice(stmtRange[1]);
    const pos = lineCol(src, stmtRange[0]);
    columnShifts[pos.line] = (columnShifts[pos.line] ?? 0) + RETURN_PREFIX.length;
    returnInsert = { line: pos.line, column: pos.column, length: RETURN_PREFIX.length };
  }
  // Imports cannot live inside a function body; explain instead of a cryptic error.
  for (const stmt of program.body) {
    if (stmt.type === "ImportDeclaration" || stmt.type.startsWith("Export")) {
      throw new ScriptSyntaxError(
        "import/export are not available in dev-browser scripts. Everything you need is already in scope (browser, console, saveFile, readFile).",
        stmt.loc?.start.line,
      );
    }
  }
  return { code: WRAPPER_PREFIX + body + "\n})", lineOffset: 0, line1ColumnShift: WRAPPER_PREFIX.length, columnShifts, returnInsert };
}

function isObjectLikeBlock(block: Stmt): boolean {
  const body = block.body as Stmt[] | undefined;
  if (!Array.isArray(body)) return false;
  if (body.length === 0) return true; // `{}`
  return body.every((s) => s.type === "LabeledStatement");
}

function lineCol(src: string, index: number): { line: number; column: number } {
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < index; i++) {
    if (src.charCodeAt(i) === 10) {
      line++;
      lastNl = i;
    }
  }
  return { line, column: index - lastNl - 1 };
}
