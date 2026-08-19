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
}

export function formatScriptError(err: unknown, scriptName: string, opts: FormatOptions = {}): FormattedError {
  if (err === null || err === undefined) return { name: "Error", message: String(err) };
  if (typeof err !== "object") return { name: "Error", message: String(err) };
  const e = err as { name?: unknown; message?: unknown; stack?: unknown };
  const name = typeof e.name === "string" && e.name.length > 0 ? e.name : "Error";
  const message = typeof e.message === "string" ? e.message : String(err);
  const stack = typeof e.stack === "string" ? cleanStack(e.stack, scriptName, message, opts) : undefined;
  return { name, message, stack };
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
    let col = Number(m[3]);
    const shift = opts.columnShifts ? (opts.columnShifts[Number(line)] ?? 0) : line === "1" ? (opts.line1ColumnShift ?? 0) : 0;
    if (shift) col = Math.max(1, col - shift);
    frames.push(fn ? `    at ${fn} (${scriptName}:${line}:${col})` : `    at ${scriptName}:${line}:${col}`);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.length > 0 ? frames.join("\n") : undefined;
}
