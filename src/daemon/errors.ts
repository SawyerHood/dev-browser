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

export function formatScriptError(err: unknown, scriptName: string): FormattedError {
  if (err === null || err === undefined) return { name: "Error", message: String(err) };
  if (typeof err !== "object") return { name: "Error", message: String(err) };
  const e = err as { name?: unknown; message?: unknown; stack?: unknown };
  const name = typeof e.name === "string" && e.name.length > 0 ? e.name : "Error";
  const message = typeof e.message === "string" ? e.message : String(err);
  const stack = typeof e.stack === "string" ? cleanStack(e.stack, scriptName, message) : undefined;
  return { name, message, stack };
}

export function cleanStack(stack: string, scriptName: string, message: string): string | undefined {
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
    frames.push(fn ? `    at ${fn} (${scriptName}:${m[2]}:${m[3]})` : `    at ${scriptName}:${m[2]}:${m[3]}`);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.length > 0 ? frames.join("\n") : undefined;
}
