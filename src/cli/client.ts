/**
 * Client side: ensure a daemon is running, send one request, stream frames.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import { spawn } from "node:child_process";
import {
  encodeFrame,
  LineDecoder,
  PROTOCOL_VERSION,
  type Frame,
  type HelloFromDaemon,
  type Request,
} from "../shared/protocol.ts";
import { paths, ensureHome } from "../shared/paths.ts";
import { VERSION } from "../shared/version.ts";

const SPAWN_POLL_MS = 20;
const SPAWN_WAIT_MS = 10_000;
const LOCK_STALE_MS = 15_000;

export function isCompiled(): boolean {
  return typeof Bun !== "undefined" && typeof Bun.main === "string" && Bun.main.startsWith("/$bunfs/");
}

function tryConnect(socketPath: string, timeoutMs: number): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const s = net.createConnection(socketPath);
    const t = setTimeout(() => {
      s.destroy();
      resolve(null);
    }, timeoutMs);
    s.once("connect", () => {
      clearTimeout(t);
      resolve(s);
    });
    s.once("error", () => {
      clearTimeout(t);
      resolve(null);
    });
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Spawn lock: O_EXCL file holding our pid. Returns true if we hold it. */
function acquireSpawnLock(): boolean {
  const lock = paths.lock();
  try {
    const fd = fs.openSync(lock, "wx", 0o600);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
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
  try {
    if (fs.readFileSync(paths.lock(), "utf8").trim() === String(process.pid)) fs.unlinkSync(paths.lock());
  } catch {
    /* ignore */
  }
}

export function spawnDaemon(): void {
  ensureHome();
  const logFd = fs.openSync(paths.log(), "a", 0o600);
  const args = isCompiled() ? ["daemon"] : [Bun.main, "daemon"];
  const env = { ...process.env };
  delete env.NODE_PATH; // never let a host app's module paths leak into the daemon
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env,
  });
  child.unref();
  fs.closeSync(logFd);
}

/**
 * Connect to the daemon, starting one if needed. Throws after SPAWN_WAIT_MS.
 */
export async function ensureDaemon(): Promise<net.Socket> {
  ensureHome();
  const socketPath = paths.socket();
  const first = await tryConnect(socketPath, 300);
  if (first) return first;

  const deadline = Date.now() + SPAWN_WAIT_MS;
  let spawned = false;
  if (acquireSpawnLock()) {
    try {
      // Re-check under the lock; another client may have started one meanwhile.
      const again = await tryConnect(socketPath, 200);
      if (again) return again;
      spawnDaemon();
      spawned = true;
    } finally {
      // Keep the lock until the daemon answers, so parallel clients wait instead of double-spawning.
    }
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

export interface SendOptions {
  /** Give up waiting for the first frame after this many ms. */
  firstFrameTimeoutMs?: number;
  /** Give up entirely after this many ms without any frame. */
  idleTimeoutMs?: number;
  onFrame: (frame: Frame) => void;
}

/**
 * Send one request and stream frames. Handles version mismatch by asking the
 * old daemon to exit and retrying once against a fresh daemon.
 */
export async function sendRequest(req: Request, opts: SendOptions): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const sock = await ensureDaemon();
    const outcome = await talk(sock, req, opts);
    if (outcome === "retry") continue;
    return;
  }
  throw new Error("daemon version mismatch persisted after restart");
}

async function talk(sock: net.Socket, req: Request, opts: SendOptions): Promise<"ok" | "retry"> {
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
          sock.destroy();
          reject(new Error(`no response from daemon for ${Math.round(ms / 1000)}s`));
        }, ms);
      }
    };
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      let frames: Frame[];
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        sock.destroy();
        reject(err);
        return;
      }
      for (const f of frames) {
        if (!gotHello) {
          gotHello = true;
          const h = f as HelloFromDaemon;
          if (h.type !== "hello") {
            sock.destroy();
            reject(new Error("daemon spoke an unknown protocol"));
            return;
          }
          resetTimer(opts.idleTimeoutMs);
          continue;
        }
        if (f.type === "error" && f.kind === "version") {
          // Old daemon: ask it to exit, then retry with a fresh one.
          retry = true;
          sock.write(encodeFrame({ type: "shutdown" }));
          continue;
        }
        if (f.type === "done" && retry) {
          continue; // wait for the socket to close after shutdown
        }
        resetTimer(opts.idleTimeoutMs);
        opts.onFrame(f);
        if (f.type === "done") done = true;
      }
    });
    sock.on("error", (err) => {
      if (!done) reject(err);
    });
    sock.on("close", () => {
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
    resetTimer(opts.firstFrameTimeoutMs ?? 10_000);
    sock.write(encodeFrame({ type: "hello", version: VERSION, protocol: PROTOCOL_VERSION }));
    sock.write(encodeFrame(req));
  });
}
