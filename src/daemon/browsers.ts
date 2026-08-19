/**
 * Browser registry: one entry per browser key, lazy connect under a
 * per-key mutex, idle reaper for launched browsers, stop.
 */
import type { Browser } from "puppeteer-core";
import type { BrowserInfo, BrowserSourceSpec } from "../shared/protocol.ts";
import { sanitizeName } from "../shared/paths.ts";
import type { FileLogger } from "../shared/log.ts";
import { PageRegistry } from "./pages.ts";
import { launchBrowser } from "./sources/launch.ts";
import { connectCdp } from "./sources/cdp.ts";
import { connectSocket } from "./sources/socket.ts";

export interface BrowserEntry {
  key: string;
  spec: BrowserSourceSpec;
  browser: Browser;
  pages: PageRegistry;
  lastActivity: number;
  idleTimeoutMs: number;
  activeRuns: number;
  wsEndpoint?: string;
  /** True when doobie launched the process (eligible for idle cleanup). */
  launched: boolean;
}

export function keyFor(spec: BrowserSourceSpec): string {
  switch (spec.kind) {
    case "launch":
      return sanitizeName(spec.name) + (spec.headless ? ":headless" : "");
    case "cdp":
      return "cdp:" + spec.url;
    case "socket":
      return "socket:" + spec.path;
  }
}

export class BrowserManager {
  private entries = new Map<string, BrowserEntry>();
  private pending = new Map<string, Promise<BrowserEntry>>();
  private reaperTimer: ReturnType<typeof setTimeout> | null = null;
  onEmpty: (() => void) | null = null;

  constructor(private readonly log: FileLogger) {}

  list(): BrowserInfo[] {
    const now = Date.now();
    return [...this.entries.values()].map((e) => ({
      key: e.key,
      kind: e.spec.kind,
      name: e.spec.kind === "launch" ? e.spec.name : undefined,
      headless: e.spec.kind === "launch" ? e.spec.headless : undefined,
      connected: e.browser.connected,
      pages: e.browser.targets().filter((t) => t.type() === "page").length,
      idleMs: now - e.lastActivity,
      idleTimeoutMs: e.idleTimeoutMs,
      wsEndpoint: e.wsEndpoint,
    }));
  }

  size(): number {
    return this.entries.size;
  }

  peek(key: string): BrowserEntry | undefined {
    return this.entries.get(key);
  }

  /** Get or create the entry for a spec. Concurrent calls for one key share one connect. */
  async get(spec: BrowserSourceSpec, opts: { timeoutMs: number; idleTimeoutMs: number }): Promise<BrowserEntry> {
    const key = keyFor(spec);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.browser.connected) {
        existing.idleTimeoutMs = opts.idleTimeoutMs;
        this.touch(existing);
        return existing;
      }
      this.drop(key, "disconnected");
    }
    let p = this.pending.get(key);
    if (!p) {
      p = this.connect(key, spec, opts).finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }

  private async connect(
    key: string,
    spec: BrowserSourceSpec,
    opts: { timeoutMs: number; idleTimeoutMs: number },
  ): Promise<BrowserEntry> {
    let browser: Browser;
    let launched = false;
    let wsEndpoint: string | undefined;
    if (spec.kind === "launch") {
      const r = await launchBrowser(spec, this.log, { timeoutMs: opts.timeoutMs });
      browser = r.browser;
      launched = true;
      wsEndpoint = browser.wsEndpoint();
    } else if (spec.kind === "cdp") {
      const r = await connectCdp(spec, this.log);
      browser = r.browser;
      wsEndpoint = r.resolved.wsEndpoint;
    } else {
      browser = await connectSocket(spec, this.log);
    }
    const entry: BrowserEntry = {
      key,
      spec,
      browser,
      pages: new PageRegistry(browser, key),
      lastActivity: Date.now(),
      idleTimeoutMs: opts.idleTimeoutMs,
      activeRuns: 0,
      wsEndpoint,
      launched,
    };
    if (launched) {
      for (const t of browser.targets()) {
        if (t.type() !== "page") continue;
        const id = (t as unknown as { _targetId?: string })._targetId;
        if (id) entry.pages.initialTargetIds.add(id);
      }
    }
    browser.once("disconnected", () => {
      if (this.entries.get(key) === entry) this.drop(key, "browser disconnected");
    });
    browser.on("targetdestroyed", (t) => {
      const id = (t as unknown as { _targetId?: string })._targetId;
      if (id) entry.pages.forgetTarget(id);
    });
    this.entries.set(key, entry);
    this.scheduleReaper();
    return entry;
  }

  touch(entry: BrowserEntry): void {
    entry.lastActivity = Date.now();
    this.scheduleReaper();
  }

  private drop(key: string, why: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.log.info(`browser ${key} removed: ${why}`);
    if (this.entries.size === 0) this.onEmpty?.();
  }

  /**
   * Stop one browser (by key or profile name) or all. Launched browsers are
   * closed; attached browsers are disconnected. Returns the number stopped.
   */
  async stop(which?: string): Promise<number> {
    const targets = [...this.entries.values()].filter((e) => {
      if (!which) return true;
      if (e.key === which) return true;
      return e.spec.kind === "launch" && sanitizeName(e.spec.name) === sanitizeName(which);
    });
    for (const e of targets) {
      this.entries.delete(e.key);
      try {
        if (e.launched) await e.browser.close();
        else await e.browser.disconnect();
      } catch (err) {
        this.log.warn(`stop ${e.key} failed`, err);
      }
      this.log.info(`stopped ${e.key}`);
    }
    if (this.entries.size === 0) this.onEmpty?.();
    return targets.length;
  }

  async stopAll(): Promise<void> {
    await this.stop();
  }

  /* ---------------- idle reaper ---------------- */

  private scheduleReaper(): void {
    if (this.reaperTimer) {
      clearTimeout(this.reaperTimer);
      this.reaperTimer = null;
    }
    let earliest = Infinity;
    const now = Date.now();
    for (const e of this.entries.values()) {
      if (!e.launched || e.idleTimeoutMs <= 0) continue;
      earliest = Math.min(earliest, e.lastActivity + e.idleTimeoutMs - now);
    }
    if (!Number.isFinite(earliest)) return;
    this.reaperTimer = setTimeout(() => void this.reap(), Math.max(50, earliest));
    if (typeof this.reaperTimer === "object" && "unref" in this.reaperTimer) this.reaperTimer.unref();
  }

  private async reap(): Promise<void> {
    this.reaperTimer = null;
    const now = Date.now();
    for (const e of [...this.entries.values()]) {
      if (!e.launched || e.idleTimeoutMs <= 0 || e.activeRuns > 0) continue;
      if (now - e.lastActivity >= e.idleTimeoutMs) {
        this.log.info(`idle reaper closing ${e.key} after ${Math.round((now - e.lastActivity) / 1000)}s`);
        await this.stop(e.key);
      }
    }
    this.scheduleReaper();
  }
}
