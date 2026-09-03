/**
 * Error formatting for script failures: `Name: message` plus a cleaned stack
 * that keeps only frames from the user's script, rewritten to `at <script>:L:C`.
 */

export interface FormattedError {
  name: string;
  message: string;
  stack?: string;
}

const MAX_FRAMES = 5;

export interface FormatOptions {
  /** Subtract this from columns reported on line 1 (the transform wrapper prefix). */
  line1ColumnShift?: number;
  /** Per-line column shifts introduced by the transform; overrides line1ColumnShift when given. */
  columnShifts?: Record<number, number>;
  /**
   * Where the transform inserted `return (`. On that line only frames at or
   * after the insertion point are shifted by `length`; the rest of the
   * line's shift (the line-1 wrapper) always applies.
   */
  returnInsert?: { line: number; column: number; length: number } | null;
}

export function formatScriptError(err: unknown, scriptName: string, opts: FormatOptions = {}): FormattedError {
  if (err === null || err === undefined) return { name: "Error", message: String(err) };
  if (typeof err !== "object") return { name: "Error", message: String(err) };
  const e = err as { name?: unknown; message?: unknown; stack?: unknown; cause?: unknown };
  const name = typeof e.name === "string" && e.name.length > 0 ? e.name : "Error";
  let message = typeof e.message === "string" ? e.message : String(err);
  // Puppeteer 25 puts the detail ("Waiting failed: 5000ms exceeded") in err.cause.
  const causeMessage = causeText(e.cause);
  if (causeMessage && !message.includes(causeMessage)) message += ` (cause: ${causeMessage})`;
  const stack = typeof e.stack === "string" ? cleanStack(e.stack, scriptName, typeof e.message === "string" ? e.message : message, opts) : undefined;
  return { name, message, stack };
}

function causeText(cause: unknown): string | undefined {
  if (cause === null || cause === undefined) return undefined;
  if (typeof cause === "string") return cause.length > 0 ? cause : undefined;
  if (typeof cause === "object") {
    const m = (cause as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) return m;
  }
  return undefined;
}

export function cleanStack(stack: string, scriptName: string, message: string, opts: FormatOptions = {}): string | undefined {
  const lines = stack.split("\n");
  // Drop the header line(s) that repeat name/message.
  let start = 0;
  const header = lines.slice(0, Math.max(1, message.split("\n").length));
  if (header.join("\n").includes(message) || /^\w*Error/.test(lines[0] ?? "")) start = header.length;
  const frames: string[] = [];
  const escaped = scriptName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*at\\s+(?:(.*?)\\s+\\()?${escaped}:(\\d+):(\\d+)\\)?\\s*$`);
  for (const raw of lines.slice(start)) {
    const m = re.exec(raw);
    if (!m) continue;
    const fn = m[1] && !/^(?:async\s+)?(?:<anonymous>|eval|Object\.<anonymous>)$/.test(m[1]) ? m[1] : "";
    const line = m[2]!;
    const col = adjustColumn(Number(line), Number(m[3]), opts);
    frames.push(fn ? `    at ${fn} (${scriptName}:${line}:${col})` : `    at ${scriptName}:${line}:${col}`);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.length > 0 ? frames.join("\n") : undefined;
}

/** Map a column reported against the transformed source back to the user's source. */
export function adjustColumn(line: number, col: number, opts: FormatOptions): number {
  let shift = opts.columnShifts ? (opts.columnShifts[line] ?? 0) : line === 1 ? (opts.line1ColumnShift ?? 0) : 0;
  const ri = opts.returnInsert;
  if (ri && ri.line === line && shift >= ri.length) {
    const unconditional = shift - ri.length; // the line-1 wrapper part, if any
    const pos0 = col - 1 - unconditional; // 0-based column in "user source with `return (` inserted"
    if (pos0 >= ri.column + ri.length) shift = unconditional + ri.length;
    else if (pos0 > ri.column) shift = unconditional + (pos0 - ri.column); // inside the inserted text: clamp to the insertion point
    else shift = unconditional;
  }
  return shift ? Math.max(1, col - shift) : col;
}
