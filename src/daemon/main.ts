/**
 * Daemon entry: bind the Unix socket (bind-first, stale-socket aware),
 * answer requests, exit after 15 min without browsers, log to a file.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import {
  encodeFrame,
  LineDecoder,
  PROTOCOL_VERSION,
  type Frame,
  type HelloFromClient,
  type Request,
  type StatusPayload,
  type PagesPayload,
  EXIT_ERROR,
  EXIT_OK,
} from "../shared/protocol.ts";
import { paths, ensureHome } from "../shared/paths.ts";
import { DEFAULTS } from "../shared/config.ts";
import { VERSION } from "../shared/version.ts";
import { FileLogger } from "../shared/log.ts";
import { BrowserManager } from "./browsers.ts";
import { runScript } from "./run.ts";

const MAX_REQUEST_CHARS = 20 * 1024 * 1024;

export interface DaemonOptions {
  socketPath?: string;
  idleExitMs?: number;
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<void> {
  ensureHome();
  const socketPath = opts.socketPath ?? paths.socket();
  const idleExitMs = opts.idleExitMs ?? DEFAULTS.daemonIdleExitMs;
  const log = new FileLogger(paths.log());
  const manager = new BrowserManager(log);
  const startedAt = Date.now();
  let activeRequests = 0;
  let closing = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let ownsEndpoint = false;
  let socketIno: number | null = null;

  const server = net.createServer();

  const scheduleIdleExit = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (manager.size() > 0 || activeRequests > 0) return;
    idleTimer = setTimeout(() => {
      if (manager.size() === 0 && activeRequests === 0) {
        log.info(`idle for ${Math.round(idleExitMs / 60000)}m with no browsers, exiting`);
        void shutdown(0);
      }
    }, idleExitMs);
  };
  manager.onEmpty = scheduleIdleExit;

  /**
   * Release the endpoint synchronously, and only what is still ours: the pid
   * file if it holds our pid, the socket path if it is the inode we bound.
   * Must run BEFORE anything async in shutdown: a client that connects right
   * after `doobie stop` spawns the next daemon within milliseconds, and a
   * late unlink would delete that daemon's socket (leaving it orphaned).
   */
  const releaseEndpoint = () => {
    if (!ownsEndpoint) return;
    ownsEndpoint = false;
    try {
      if (fs.readFileSync(paths.pid(), "utf8").trim() === String(process.pid)) fs.unlinkSync(paths.pid());
    } catch {
      /* gone or not ours */
    }
    try {
      if (socketIno !== null && fs.statSync(socketPath).ino === socketIno) fs.unlinkSync(socketPath);
    } catch {
      /* gone or not ours */
    }
  };

  const shutdown = async (code: number) => {
    if (closing) return;
    closing = true;
    log.info("shutting down");
    releaseEndpoint();
    // Deliberately no server.close(): Bun unlinks the listen path on close,
    // which would remove a successor daemon's socket. The path is already
    // unlinked above; process.exit() below closes the listening fd without
    // touching the filesystem.
    try {
      await manager.stopAll();
    } catch (err) {
      log.warn("stopAll failed", err);
    }
    setTimeout(() => process.exit(code), 50).unref();
  };

  server.on("connection", (sock) => {
    if (closing) {
      // Endpoint already released; whoever still reaches us raced the unlink.
      sock.end(
        encodeFrame({ type: "hello", version: VERSION, protocol: PROTOCOL_VERSION, pid: process.pid }) +
          encodeFrame({ type: "error", kind: "daemon", name: "DaemonError", message: "daemon is shutting down; re-run the command" }) +
          encodeFrame({ type: "done", exitCode: EXIT_ERROR, durationMs: 0 }),
      );
      return;
    }
    sock.setEncoding("utf8");
    const decoder = new LineDecoder<HelloFromClient | Request>(MAX_REQUEST_CHARS);
    const send = (frame: Frame) => {
      if (!sock.destroyed) sock.write(encodeFrame(frame));
    };
    let gotHello = false;
    let handled = false;
    let mismatched = false;
    const abort = new AbortController();
    sock.on("close", () => abort.abort());
    sock.on("error", () => abort.abort());

    sock.on("data", (chunk: string) => {
      let msgs: Array<HelloFromClient | Request>;
      try {
        msgs = decoder.push(chunk);
      } catch (err) {
        send({ type: "error", kind: "usage", name: "ProtocolError", message: (err as Error).message });
        send({ type: "done", exitCode: EXIT_ERROR, durationMs: 0 });
        sock.end();
        return;
      }
      for (const msg of msgs) {
        if (!gotHello) {
          gotHello = true;
          const hello = msg as HelloFromClient;
          send({ type: "hello", version: VERSION, protocol: PROTOCOL_VERSION, pid: process.pid });
          if (hello.type !== "hello" || hello.version !== VERSION || hello.protocol !== PROTOCOL_VERSION) {
            send({
              type: "error",
              kind: "version",
              name: "VersionMismatch",
              message: `daemon is ${VERSION}, client is ${hello.version ?? "unknown"}`,
              daemonVersion: VERSION,
            });
            send({ type: "done", exitCode: EXIT_ERROR, durationMs: 0 });
            // The client will send shutdown next; keep the socket open for it.
            mismatched = true;
          }
          continue;
        }
        if (handled) continue;
        // After a mismatch only `shutdown` is honored; never run a newer client's request here.
        if (mismatched && (msg as Request).type !== "shutdown") continue;
        handled = true;
        void handle(msg as Request, send, abort.signal)
          .catch((err) => {
            log.error("request failed", err);
            send({ type: "error", kind: "daemon", name: "DaemonError", message: (err as Error)?.message ?? String(err) });
            send({ type: "done", exitCode: EXIT_ERROR, durationMs: 0 });
          })
          .finally(() => {
            if (!sock.destroyed) sock.end();
          });
      }
    });
  });

  async function handle(req: Request, send: (f: Frame) => void, signal: AbortSignal): Promise<void> {
    const t0 = Date.now();
    activeRequests++;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    try {
      switch (req.type) {
        case "run": {
          const outcome = await runScript(req, { manager, log, emit: send, signal });
          send({ type: "done", exitCode: outcome.exitCode, durationMs: Date.now() - t0 });
          return;
        }
        case "pages": {
          const sources = req.source ? [req.source] : [];
          const payloads: PagesPayload[] = [];
          if (sources.length === 0) {
            for (const info of manager.list()) {
              const e = manager.peek(info.key);
              if (!e) continue;
              payloads.push({ browser: info.key, pages: await e.pages.listPages() });
            }
          } else {
            for (const s of sources) {
              const e = await manager.get(s, { timeoutMs: 20_000, idleTimeoutMs: DEFAULTS.idleTimeoutMs });
              payloads.push({ browser: e.key, pages: await e.pages.listPages() });
            }
          }
          send({ type: "data", payload: payloads });
          send({ type: "done", exitCode: EXIT_OK, durationMs: Date.now() - t0 });
          return;
        }
        case "browsers": {
          send({ type: "data", payload: manager.list() });
          send({ type: "done", exitCode: EXIT_OK, durationMs: Date.now() - t0 });
          return;
        }
        case "status": {
          const payload: StatusPayload = {
            pid: process.pid,
            version: VERSION,
            uptimeMs: Date.now() - startedAt,
            socketPath,
            logPath: paths.log(),
            activeRuns: activeRequests - 1,
            browsers: manager.list(),
            logTail: log.tail(15),
          };
          send({ type: "data", payload });
          send({ type: "done", exitCode: EXIT_OK, durationMs: Date.now() - t0 });
          return;
        }
        case "stop": {
          if (req.browser) {
            const n = await manager.stop(req.browser);
            send({ type: "data", payload: { stopped: n } });
            send({ type: "done", exitCode: n > 0 ? EXIT_OK : EXIT_ERROR, durationMs: Date.now() - t0 });
          } else {
            const n = manager.size();
            send({ type: "data", payload: { stopped: n, daemon: true } });
            send({ type: "done", exitCode: EXIT_OK, durationMs: Date.now() - t0 });
            void shutdown(0);
          }
          return;
        }
        case "shutdown": {
          send({ type: "done", exitCode: EXIT_OK, durationMs: 0 });
          void shutdown(0);
          return;
        }
        default: {
          send({ type: "error", kind: "usage", name: "ProtocolError", message: `unknown request type ${(req as { type: string }).type}` });
          send({ type: "done", exitCode: EXIT_ERROR, durationMs: 0 });
        }
      }
    } finally {
      activeRequests--;
      scheduleIdleExit();
    }
  }

  // ---- bind first; if the path is busy, probe it; unlink only if stale.
  await new Promise<void>((resolve, reject) => {
    const tryListen = (attempt: number) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempt === 0) {
          const probe = net.createConnection(socketPath);
          probe.once("connect", () => {
            probe.destroy();
            reject(new Error("another daemon is already listening"));
          });
          probe.once("error", () => {
            try {
              fs.unlinkSync(socketPath);
            } catch {
              /* ignore */
            }
            tryListen(1);
          });
          return;
        }
        reject(err);
      });
      server.listen(socketPath, () => {
        server.removeAllListeners("error");
        server.on("error", (e) => log.error("server error", e));
        resolve();
      });
    };
    tryListen(0);
  });
  ownsEndpoint = true;
  try {
    fs.chmodSync(socketPath, 0o600);
    socketIno = fs.statSync(socketPath).ino;
  } catch {
    /* ignore */
  }
  fs.writeFileSync(paths.pid(), String(process.pid), { mode: 0o600 });
  log.info(`daemon ${VERSION} listening on ${socketPath} (pid ${process.pid})`);
  scheduleIdleExit();

  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  process.on("uncaughtException", (err) => log.error("uncaughtException", err));
  process.on("unhandledRejection", (err) => log.error("unhandledRejection", err as Error));
}
