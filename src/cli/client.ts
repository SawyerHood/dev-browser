/**
 * Client side: ensure a daemon is running, send one request, stream frames.
 *
 * Hot path uses Bun-native APIs (Bun.connect, Bun.spawn) and loads node:fs
 * lazily: importing node:net/fs/child_process costs ~10 ms of startup under
 * Bun, and the client's whole job is to be fast.
 */
import type { Socket } from "bun";
import {
  encodeFrame,
  LineDecoder,
  PROTOCOL_VERSION,
  type Frame,
  type HelloFromDaemon,
  type Request,
} from "../shared/protocol.ts";
import { paths, ensureHome, lazyFs } from "../shared/paths.ts";
import { VERSION } from "../shared/version.ts";
import { err as writeErr } from "./io.ts";

const SPAWN_POLL_MS = 20;
const SPAWN_WAIT_MS = 10_000;
const LOCK_STALE_MS = 15_000;
/** A healthy daemon answers hello in microseconds; beyond this it is hung. */
const HELLO_TIMEOUT_MS = 5_000;

export class DaemonHungError extends Error {
  constructor() {
    super("daemon did not answer the handshake; it looks hung");
    this.name = "DaemonHungError";
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill the daemon recorded in the pid file and remove its socket. */
export function killDaemon(): boolean {
  const fs = lazyFs();
  let killed = false;
  try {
    const pid = Number(fs.readFileSync(paths.pid(), "utf8").trim());
    if (Number.isInteger(pid) && pid > 1 && pidAlive(pid)) {
      process.kill(pid, "SIGKILL");
      killed = true;
    }
  } catch {
    /* no pid file */
  }
  for (const f of [paths.socket(), paths.pid()]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  return killed;
}

export function isCompiled(): boolean {
  return typeof Bun !== "undefined" && typeof Bun.main === "string" && Bun.main.startsWith("/$bunfs/");
}

/* ------------------------------------------------------------------ */
/* Socket wrapper over Bun.connect                                     */
/* ------------------------------------------------------------------ */

export interface Conn {
  /** Queue data for sending; honors socket backpressure (see `createConn`). */
  write(data: string | Uint8Array): void;
  /** Half-close once everything queued has been flushed. */
  end(): void;
  destroy(): void;
  onData(cb: (chunk: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: Error) => void): void;
}

type Handlers = { data?: (c: Uint8Array) => void; close?: () => void; error?: (e: Error) => void };

/**
 * Wrap a Bun socket. `Socket.write` returns the number of bytes the kernel
 * accepted and silently drops the rest once the send buffer is full (~200 KB
 * for a Unix socket), so anything larger than that (a script with embedded
 * data, a long --eval) must be queued and flushed from the `drain` callback.
 */
function createConn(s: Socket<unknown>, h: Handlers): Conn & { drain(): void } {
  const queue: Uint8Array[] = [];
  let endWhenFlushed = false;
  let closed = false;
  const flush = (): void => {
    while (queue.length > 0) {
      const head = queue[0]!;
      let n: number;
      try {
        n = s.write(head);
      } catch {
        return; // socket gone; the close/error handlers report it
      }
      if (n < head.byteLength) {
        if (n > 0) queue[0] = head.subarray(n);
        return; // wait for drain
      }
      queue.shift();
    }
    if (endWhenFlushed && !closed) {
      closed = true;
      s.end();
    }
  };
  return {
    write: (d) => {
      if (closed) return;
      const bytes = typeof d === "string" ? new TextEncoder().encode(d) : d;
      if (bytes.byteLength === 0) return;
      queue.push(bytes);
      if (queue.length === 1) flush(); // otherwise a drain is already pending
    },
    end: () => {
      endWhenFlushed = true;
      if (queue.length === 0 && !closed) {
        closed = true;
        s.end();
      }
    },
    destroy: () => {
      closed = true;
      queue.length = 0;
      s.terminate();
    },
    onData: (cb) => (h.data = cb),
    onClose: (cb) => (h.close = cb),
    onError: (cb) => (h.error = cb),
    drain: flush,
  };
}

export function tryConnect(socketPath: string, timeoutMs: number): Promise<Conn | null> {
  return new Promise((resolve) => {
    const h: Handlers = {};
    let settled = false;
    let sock: Socket<undefined> | null = null;
    let conn: (Conn & { drain(): void }) | null = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock?.end();
      resolve(null);
    }, timeoutMs);
    Bun.connect({
      unix: socketPath,
      socket: {
        open(s) {
          sock = s;
          if (settled) {
            s.end();
            return;
          }
          settled = true;
          clearTimeout(timer);
          conn = createConn(s, h);
          resolve(conn);
        },
        drain() {
          conn?.drain();
        },
        data(_s, chunk) {
          h.data?.(chunk);
        },
        close() {
          h.close?.();
        },
        error(_s, err) {
          h.error?.(err);
        },
        connectError() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(null);
        },
      },
    }).catch(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Daemon spawn                                                        */
/* ------------------------------------------------------------------ */

/** Spawn lock: O_EXCL file holding our pid. Returns true if we hold it. */
function acquireSpawnLock(): boolean {
  const fs = lazyFs();
  const lock = paths.lock();
  try {
    const fd = fs.openSync(lock, "wx", 0o600);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      throw new Error(
        `cannot write to DOOBIE_HOME ${paths.home()} (${code ?? (err as Error).message}). Fix its permissions or point DOOBIE_HOME at a writable directory.`,
      );
    }
    try {
      const st = fs.statSync(lock);
      const pid = Number(fs.readFileSync(lock, "utf8").trim());
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS || !pidAlive(pid)) {
        fs.unlinkSync(lock);
        return acquireSpawnLock();
      }
    } catch {
      /* race: someone else cleaned up */
    }
    return false;
  }
}

function releaseSpawnLock(): void {
  const fs = lazyFs();
  try {
    if (fs.readFileSync(paths.lock(), "utf8").trim() === String(process.pid)) fs.unlinkSync(paths.lock());
  } catch {
    /* ignore */
  }
}

export function spawnDaemon(): void {
  ensureHome();
  const fs = lazyFs();
  const logFd = fs.openSync(paths.log(), "a", 0o600);
  const args = isCompiled() ? [process.execPath, "daemon"] : [process.execPath, Bun.main, "daemon"];
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.NODE_PATH; // never let a host app's module paths leak into the daemon
  const child = Bun.spawn(args, {
    stdio: ["ignore", logFd, logFd],
    env: env as Record<string, string>,
    // Own session so the daemon survives this client and its terminal.
    detached: true,
  } as Parameters<typeof Bun.spawn>[1]);
  child.unref();
  fs.closeSync(logFd);
}

/**
 * Connect to the daemon, starting one if needed. Throws after SPAWN_WAIT_MS.
 */
export async function ensureDaemon(): Promise<Conn> {
  const socketPath = paths.socket();
  const first = await tryConnect(socketPath, 300);
  if (first) return first;
  ensureHome();

  const deadline = Date.now() + SPAWN_WAIT_MS;
  let spawned = false;
  if (acquireSpawnLock()) {
    // Re-check under the lock; another client may have started one meanwhile.
    const again = await tryConnect(socketPath, 200);
    if (again) {
      releaseSpawnLock();
      return again;
    }
    spawnDaemon();
    spawned = true;
    // Keep the lock until the daemon answers, so parallel clients wait instead of double-spawning.
  }
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SPAWN_POLL_MS));
      const s = await tryConnect(socketPath, 200);
      if (s) return s;
    }
  } finally {
    if (spawned) releaseSpawnLock();
  }
  throw new Error(
    `doobie daemon did not start within ${SPAWN_WAIT_MS / 1000}s. Check ${paths.log()} and run \`doobie status\`.`,
  );
}

/* ------------------------------------------------------------------ */
/* Request                                                             */
/* ------------------------------------------------------------------ */

export interface SendOptions {
  /** Give up waiting for the first frame after this many ms. */
  firstFrameTimeoutMs?: number;
  /** Give up entirely after this many ms without any frame. */
  idleTimeoutMs?: number;
  /**
   * When the idle timeout fires after the handshake the daemon has missed its
   * own deadline (event loop blocked by a script); kill it so the next call
   * starts a fresh one. Used for run requests, whose deadline is definitive.
   */
  killOnIdle?: boolean;
  onFrame: (frame: Frame) => void;
}

/**
 * Send one request and stream frames. Handles version mismatch by asking the
 * old daemon to exit and retrying once against a fresh daemon. A daemon that
 * does not answer the handshake is killed and restarted once.
 */
export async function sendRequest(req: Request, opts: SendOptions): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const conn = await ensureDaemon();
    let outcome: "ok" | "retry";
    try {
      outcome = await talk(conn, req, opts);
    } catch (err) {
      if (err instanceof DaemonHungError && attempt === 0) {
        writeErr("doobie: daemon unresponsive, restarting it\n");
        killDaemon();
        continue;
      }
      throw err;
    }
    if (outcome === "retry") continue;
    return;
  }
  throw new Error("daemon did not recover after a restart; check " + paths.log());
}

function talk(conn: Conn, req: Request, opts: SendOptions): Promise<"ok" | "retry"> {
  return new Promise<"ok" | "retry">((resolve, reject) => {
    const decoder = new LineDecoder<Frame>();
    let gotHello = false;
    let retry = false;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const resetTimer = (ms: number | undefined) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (ms && ms > 0) {
        timer = setTimeout(() => {
          // Reject before destroying: Bun may run the close handler synchronously.
          if (!gotHello) {
            reject(new DaemonHungError());
          } else {
            const secs = Math.round(ms / 1000);
            if (opts.killOnIdle && killDaemon()) {
              reject(new Error(`no response from daemon for ${secs}s; killed the hung daemon. Re-run the command.`));
            } else {
              reject(new Error(`no response from daemon for ${secs}s`));
            }
          }
          done = true; // suppress the close handler's "closed unexpectedly"
          conn.destroy();
        }, ms);
      }
    };
    conn.onData((chunk) => {
      let frames: Frame[];
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        reject(err as Error);
        done = true;
        conn.destroy();
        return;
      }
      for (const f of frames) {
        if (!gotHello) {
          gotHello = true;
          const h = f as HelloFromDaemon;
          if (h.type !== "hello") {
            reject(new Error("daemon spoke an unknown protocol"));
            done = true;
            conn.destroy();
            return;
          }
          resetTimer(opts.idleTimeoutMs);
          continue;
        }
        if (f.type === "error" && f.kind === "version") {
          // Old daemon: ask it to exit, then retry with a fresh one.
          retry = true;
          conn.write(encodeFrame({ type: "shutdown" }));
          continue;
        }
        if (f.type === "error" && f.kind === "daemon" && /shutting down/.test(f.message)) {
          // We raced a daemon that is exiting (stop/upgrade): retry against its successor.
          retry = true;
          continue;
        }
        if (retry) continue; // nothing else from an old daemon is shown
        resetTimer(opts.idleTimeoutMs);
        opts.onFrame(f);
        if (f.type === "done") done = true;
      }
    });
    conn.onError((err) => {
      if (!done) reject(err);
    });
    conn.onClose(() => {
      if (timer) clearTimeout(timer);
      if (retry) {
        // Give the old daemon a moment to release the socket path.
        setTimeout(() => resolve("retry"), 150);
        return;
      }
      if (!done) {
        reject(new Error("daemon connection closed unexpectedly. Check " + paths.log()));
        return;
      }
      resolve("ok");
    });
    resetTimer(opts.firstFrameTimeoutMs ?? HELLO_TIMEOUT_MS);
    conn.write(encodeFrame({ type: "hello", version: VERSION, protocol: PROTOCOL_VERSION }) + encodeFrame(req));
  });
}
