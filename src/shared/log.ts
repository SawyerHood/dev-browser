/**
 * Tiny rolling file logger for the daemon. Never throws.
 */
import * as fs from "node:fs";

const MAX_BYTES = 5 * 1024 * 1024;

export class FileLogger {
  private fd: number | null = null;
  private bytes = 0;
  constructor(private readonly file: string) {
    this.open();
  }

  private open(): void {
    try {
      this.fd = fs.openSync(this.file, "a", 0o600);
      this.bytes = fs.fstatSync(this.fd).size;
    } catch {
      this.fd = null;
    }
  }

  private rotate(): void {
    try {
      if (this.fd !== null) fs.closeSync(this.fd);
      fs.renameSync(this.file, this.file + ".1");
    } catch {
      /* ignore */
    }
    this.open();
  }

  log(level: "info" | "warn" | "error", msg: string, extra?: unknown): void {
    if (this.fd === null) return;
    const ts = new Date().toISOString();
    let line = `${ts} ${level.padEnd(5)} ${msg}`;
    if (extra !== undefined) {
      try {
        line += " " + (extra instanceof Error ? `${extra.name}: ${extra.message}` : JSON.stringify(extra));
      } catch {
        line += " [unserializable]";
      }
    }
    line += "\n";
    try {
      fs.writeSync(this.fd, line);
      this.bytes += Buffer.byteLength(line);
      if (this.bytes > MAX_BYTES) this.rotate();
    } catch {
      /* ignore */
    }
  }

  info(msg: string, extra?: unknown): void { this.log("info", msg, extra); }
  warn(msg: string, extra?: unknown): void { this.log("warn", msg, extra); }
  error(msg: string, extra?: unknown): void { this.log("error", msg, extra); }

  /** Last `n` lines of the log file. */
  tail(n: number): string[] {
    try {
      const text = fs.readFileSync(this.file, "utf8");
      const lines = text.split("\n").filter((l) => l.length > 0);
      return lines.slice(-n);
    } catch {
      return [];
    }
  }
}
