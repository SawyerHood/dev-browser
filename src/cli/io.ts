/**
 * Cheap stdio for the client. `process.stdout.write` / `process.stdin.isTTY`
 * initialise Node's stream layer (~7 ms under Bun); Bun's FileSink writers
 * and an FFI isatty() do not.
 */

let outSink: ReturnType<typeof Bun.stdout.writer> | null = null;
let errSink: ReturnType<typeof Bun.stderr.writer> | null = null;

export function out(s: string): void {
  if (s.length === 0) return;
  if (!outSink) outSink = Bun.stdout.writer();
  outSink.write(s);
  outSink.flush();
}

export function err(s: string): void {
  if (s.length === 0) return;
  if (!errSink) errSink = Bun.stderr.writer();
  errSink.write(s);
  errSink.flush();
}

export function flushAll(): void {
  try {
    outSink?.flush();
    errSink?.flush();
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
