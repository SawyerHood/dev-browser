/**
 * Browser registry: one entry per browser key, lazy connect under a
 * per-key mutex, idle reaper for launched browsers, stop.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { Browser } from "puppeteer-core";
import type { BrowserInfo, BrowserSourceSpec } from "../shared/protocol.ts";
import { paths, sanitizeName } from "../shared/paths.ts";
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
  /** Requested key -> canonical key (cdp specs are canonicalized to their ws endpoint). */
  private aliases = new Map<string, string>();
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
    return this.entries.get(this.aliases.get(key) ?? key);
  }

  /** Get or create the entry for a spec. Concurrent calls for one key share one connect. */
  async get(spec: BrowserSourceSpec, opts: { timeoutMs: number; idleTimeoutMs: number }): Promise<BrowserEntry> {
    const key = keyFor(spec);
    const existing = this.entries.get(this.aliases.get(key) ?? key);
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
    requestedKey: string,
    spec: BrowserSourceSpec,
    opts: { timeoutMs: number; idleTimeoutMs: number },
  ): Promise<BrowserEntry> {
    let key = requestedKey;
    let browser: Browser;
    let launched = false;
    let wsEndpoint: string | undefined;
    if (spec.kind === "launch") {
      let r;
      try {
        r = await launchBrowser(spec, this.log, { timeoutMs: opts.timeoutMs });
      } catch (err) {
        // A previous daemon died without closing its Chrome (SIGKILL, crash):
        // the profile is locked by an orphan. Kill it and retry once.
        if (!/already running for/.test((err as Error)?.message ?? "") || !(await killOrphanChrome(paths.profile(spec.name), this.log))) {
          throw err;
        }
        r = await launchBrowser(spec, this.log, { timeoutMs: opts.timeoutMs });
      }
      browser = r.browser;
      launched = true;
      wsEndpoint = browser.wsEndpoint();
    } else if (spec.kind === "cdp") {
      const r = await connectCdp(spec, this.log);
      browser = r.browser;
      wsEndpoint = r.resolved.wsEndpoint;
      // "9222", "http://127.0.0.1:9222" and "auto" may all be the same Chrome:
      // key the entry (and its page names) by the resolved ws endpoint.
      const canonical = "cdp:" + wsEndpoint;
      if (canonical !== key) {
        this.aliases.set(key, canonical);
        const dup = this.entries.get(canonical);
        if (dup && dup.browser.connected) {
          await browser.disconnect().catch(() => {});
          this.touch(dup);
          return dup;
        }
        key = canonical;
      }
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
      if (e.key === which || this.aliases.get(which) === e.key) return true;
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

/**
 * Chrome's ProcessSingleton lock is a symlink `<profile>/SingletonLock -> host-pid`.
 * If that pid is alive and its command line names this profile, it is an orphan
 * Chrome from a daemon that died uncleanly: kill it and wait for it to exit.
 */
async function killOrphanChrome(profileDir: string, log: FileLogger): Promise<boolean> {
  let target: string;
  try {
    target = fs.readlinkSync(path.join(profileDir, "SingletonLock"));
  } catch {
    return false;
  }
  const pid = Number(target.slice(target.lastIndexOf("-") + 1));
  if (!Number.isInteger(pid) || pid <= 1) return false;
  let cmdline = "";
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    try {
      cmdline = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    } catch {
      return false;
    }
  }
  if (!cmdline.includes(profileDir)) return false;
  log.warn(`killing orphan Chrome pid ${pid} holding ${profileDir}`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return false;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
        try {
          fs.unlinkSync(path.join(profileDir, f));
        } catch {
          /* gone */
        }
      }
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
