/**
 * Text-mode stdout sink with a cap: stream freely up to `capChars` (50k),
 * then stop streaming, spill the full output to a file, and at the end print
 * one marker line with the path plus the last `tailChars` (5k) of output.
 *
 * stderr is never capped: it carries errors and the bounded page-console block.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULTS } from "../shared/config.ts";
import { paths, ensureHome } from "../shared/paths.ts";

export interface OutputSinkOptions {
  cap: boolean;
  runId: string;
  capChars?: number;
  tailChars?: number;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export class OutputSink {
  private total = 0;
  private streamed = "";
  private tail = "";
  private spillFd: number | null = null;
  private spillPath: string | null = null;
  private capped = false;
  private readonly capChars: number;
  private readonly tailChars: number;
  private readonly out: (s: string) => void;
  private readonly err: (s: string) => void;

  constructor(private readonly opts: OutputSinkOptions) {
    this.capChars = opts.capChars ?? DEFAULTS.outputCapChars;
    this.tailChars = opts.tailChars ?? DEFAULTS.outputTailChars;
    this.out = opts.out ?? ((s) => process.stdout.write(s));
    this.err = opts.err ?? ((s) => process.stderr.write(s));
  }

  write(stream: "stdout" | "stderr", text: string): void {
    if (text.length === 0) return;
    if (stream === "stderr") {
      this.err(text);
      return;
    }
    this.total += text.length;
    if (!this.opts.cap) {
      this.out(text);
      return;
    }
    if (!this.capped) {
      const room = this.capChars - this.streamed.length;
      if (text.length <= room) {
        this.out(text);
        this.streamed += text;
        return;
      }
      // Cross the cap: stream what fits, then switch to spill mode.
      const fits = text.slice(0, Math.max(0, room));
      if (fits.length > 0) {
        this.out(fits);
        this.streamed += fits;
      }
      this.capped = true;
      this.openSpill();
      text = text.slice(fits.length);
    }
    this.spill(text);
    this.tail = (this.tail + text).slice(-this.tailChars);
  }

  private openSpill(): void {
    try {
      ensureHome();
      this.spillPath = path.join(paths.tmp(), `out-${this.opts.runId}.txt`);
      this.spillFd = fs.openSync(this.spillPath, "w", 0o600);
      fs.writeSync(this.spillFd, this.streamed);
    } catch {
      this.spillFd = null;
      this.spillPath = null;
    }
  }

  private spill(text: string): void {
    if (this.spillFd === null) return;
    try {
      fs.writeSync(this.spillFd, text);
    } catch {
      /* ignore */
    }
  }

  finish(): void {
    if (!this.capped) return;
    if (this.spillFd !== null) {
      try {
        fs.closeSync(this.spillFd);
      } catch {
        /* ignore */
      }
      this.spillFd = null;
    }
    const hint = this.spillPath ? `; full output: ${this.spillPath} (e.g. sed -n '1,200p' ${this.spillPath})` : "";
    this.out(`\n[... stdout capped at ${this.capChars} chars, ${this.total} total${hint} ...]\n`);
    if (this.tail.length > 0) {
      this.out(`[... last ${this.tail.length} chars ...]\n` + this.tail + (this.tail.endsWith("\n") ? "" : "\n"));
    }
  }
}
