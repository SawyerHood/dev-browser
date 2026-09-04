/**
 * Socket source: raw CDP over a local stream socket, newline-delimited JSON.
 *
 * This is the hook for hosts that own a Chromium but do not expose a
 * devtools port (for example the bb desktop app's WebContentsView, proxied
 * through webContents.debugger). The host listens on a Unix socket (or a
 * Windows named pipe) and speaks browser-level CDP: every line is one
 * JSON message exactly as it would travel over the devtools websocket.
 */
import * as net from "node:net";
import puppeteer, { type Browser, type ConnectionTransport } from "puppeteer-core";
import type { SocketSource } from "../../shared/protocol.ts";
import type { FileLogger } from "../../shared/log.ts";
import { PROTOCOL_TIMEOUT_MS } from "./launch.ts";

export class SocketTransport implements ConnectionTransport {
  onmessage?: (message: string) => void;
  onclose?: () => void;
  private buf = "";
  private closed = false;

  constructor(private readonly sock: net.Socket) {
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.buf += chunk;
      let idx: number;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (line.length > 0) this.onmessage?.(line);
      }
    });
    const end = () => {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    };
    sock.on("close", end);
    sock.on("end", end);
    sock.on("error", end);
  }

  send(message: string): void {
    if (this.closed) return;
    this.sock.write(message + "\n");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sock.destroy();
  }
}

export function parseSocketPath(spec: string): { kind: "unix" | "pipe"; path: string } {
  if (spec.startsWith("unix:")) return { kind: "unix", path: spec.slice(5) };
  if (spec.startsWith("pipe:")) return { kind: "pipe", path: spec.slice(5) };
  return { kind: "unix", path: spec };
}

export async function connectSocket(spec: SocketSource, log: FileLogger): Promise<Browser> {
  const { kind, path } = parseSocketPath(spec.path);
  const target = kind === "pipe" && process.platform === "win32" ? `\\\\.\\pipe\\${path}` : path;
  const sock = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.createConnection(target);
    const onErr = (err: Error) => reject(new Error(`Could not connect to CDP socket ${spec.path}: ${err.message}`));
    s.once("error", onErr);
    s.once("connect", () => {
      s.off("error", onErr);
      resolve(s);
    });
  });
  const transport = new SocketTransport(sock);
  const t0 = Date.now();
  const browser = await puppeteer.connect({ transport, defaultViewport: null, protocolTimeout: PROTOCOL_TIMEOUT_MS });
  log.info(`connected to CDP socket ${spec.path} in ${Date.now() - t0}ms`);
  return browser;
}
