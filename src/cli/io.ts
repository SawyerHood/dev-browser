/**
 * Cheap stdio for the client. `process.stdout.write` / `process.stdin.isTTY`
 * initialise Node's stream layer (~7 ms under Bun); Bun's FileSink writers
 * and an FFI isatty() do not.
 *
 * A closed stdout/stderr pipe (`doobie ... | head`) is not an error for a
 * CLI: writes to a broken pipe are dropped silently from then on.
 */

let outSink: ReturnType<typeof Bun.stdout.writer> | null = null;
let errSink: ReturnType<typeof Bun.stderr.writer> | null = null;
let outBroken = false;
let errBroken = false;

function isBrokenPipe(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EPIPE" || code === "ECONNRESET" || /EPIPE|broken pipe/i.test(String((err as Error)?.message ?? err));
}

export function out(s: string): void {
  if (s.length === 0 || outBroken) return;
  try {
    if (!outSink) outSink = Bun.stdout.writer();
    outSink.write(s);
    outSink.flush();
  } catch (e) {
    if (!isBrokenPipe(e)) throw e;
    outBroken = true;
  }
}

export function err(s: string): void {
  if (s.length === 0 || errBroken) return;
  try {
    if (!errSink) errSink = Bun.stderr.writer();
    errSink.write(s);
    errSink.flush();
  } catch (e) {
    if (!isBrokenPipe(e)) throw e;
    errBroken = true;
  }
}

export function flushAll(): void {
  try {
    if (!outBroken) outSink?.flush();
  } catch {
    /* ignore */
  }
  try {
    if (!errBroken) errSink?.flush();
  } catch {
    /* ignore */
  }
}

export function stdinIsTTY(): boolean {
  try {
    // bun:ffi is a builtin; dlopen of libc is ~2 ms vs ~7 ms for node:tty.
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const candidates =
      process.platform === "darwin"
        ? ["libSystem.dylib", "/usr/lib/libSystem.B.dylib"]
        : ["libc.so.6", "libc.so", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1"];
    for (const name of candidates) {
      try {
        const lib = dlopen(name, { isatty: { args: [FFIType.i32], returns: FFIType.i32 } });
        return lib.symbols.isatty(0) === 1;
      } catch {
        /* try next */
      }
    }
  } catch {
    /* fall through */
  }
  return !!process.stdin.isTTY;
}
