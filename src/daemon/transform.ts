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
}

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
  const last = program.body[program.body.length - 1];
  if (last && last.type === "ExpressionStatement" && last.directive === undefined && last.expression) {
    const expr = last.expression;
    const exprText = src.slice(expr.start, expr.end);
    body = src.slice(0, last.start) + "return (" + exprText + "\n);" + src.slice(last.end);
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
  return { code: "(async () => {\n" + body + "\n})", lineOffset: -1 };
}
