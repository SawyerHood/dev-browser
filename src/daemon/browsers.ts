/**
 * Browser registry: one entry per browser key, lazy connect under a
 * per-key mutex, idle reaper for launched browsers, stop.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Browser, Target } from "puppeteer-core";
import type { BrowserInfo, BrowserSourceSpec } from "../shared/protocol.ts";
import { paths, sanitizeName } from "../shared/paths.ts";
import type { FileLogger } from "../shared/log.ts";
import { DEFAULTS } from "../shared/config.ts";
import { PageRegistry } from "./pages.ts";
import { launchBrowser } from "./sources/launch.ts";
import { connectCdp, redactEndpoint } from "./sources/cdp.ts";
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
  /** True when dev-browser launched the process (eligible for idle cleanup). */
  launched: boolean;
}

export function keyFor(spec: BrowserSourceSpec): string {
  switch (spec.kind) {
    case "launch":
      return sanitizeName(spec.name) + (spec.headless ? ":headless" : "") + (spec.ignoreHTTPSErrors ? ":insecure" : "");
    case "cdp":
      return "cdp:" + spec.url + (spec.ignoreHTTPSErrors ? ":insecure" : "");
    case "socket":
      return "socket:" + spec.path;
  }
}

/**
 * Stable identity for a resolved CDP endpoint. Keep credentials out of the
 * displayable portion while retaining them in an opaque digest so two remote
 * sessions on the same provider can never alias each other.
 */
export function canonicalCdpKey(wsEndpoint: string, ignoreHTTPSErrors = false): string {
  const digest = createHash("sha256").update(wsEndpoint).digest("hex").slice(0, 16);
  return `cdp:${redactEndpoint(wsEndpoint)}#${digest}${ignoreHTTPSErrors ? ":insecure" : ""}`;
}

/** How long a launch waits for a profile held by a live, non-orphan Chrome that is on its way out. */
const PROFILE_BUSY_WAIT_MS = 6000;

export class ProfileBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileBusyError";
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
      wsEndpoint: e.wsEndpoint ? redactEndpoint(e.wsEndpoint) : undefined,
    }));
  }

  size(): number {
    return this.entries.size;
  }

  peek(key: string): BrowserEntry | undefined {
    return this.entries.get(this.aliases.get(key) ?? key);
  }

  /** Pids of Chrome processes this daemon owns or knows to be the user's (`dev-browser chrome`). Never orphan candidates. */
  protectedPids(): Set<number> {
    const out = new Set<number>();
    for (const e of this.entries.values()) {
      const pid = e.browser.process()?.pid;
      if (pid) out.add(pid);
    }
    for (const pid of chromePortPids()) out.add(pid);
    return out;
  }

  /**
   * Get or create the entry for a spec. Concurrent calls for one key share one
   * connect. `idleTimeoutMs` is applied only when given: run requests carry
   * the user's --idle-timeout; pages/status lookups pass nothing so they never
   * reset a previously chosen timeout (a fresh connect without one uses the
   * default).
   */
  async get(spec: BrowserSourceSpec, opts: { timeoutMs: number; idleTimeoutMs?: number }): Promise<BrowserEntry> {
    const key = keyFor(spec);
    const existing = this.entries.get(this.aliases.get(key) ?? key);
    if (existing) {
      if (existing.browser.connected) {
        if (opts.idleTimeoutMs !== undefined) existing.idleTimeoutMs = opts.idleTimeoutMs;
        this.touch(existing);
        return existing;
      }
      this.drop(key, "disconnected");
    }
    let p = this.pending.get(key);
    if (!p) {
      p = this.connect(key, spec, { timeoutMs: opts.timeoutMs, idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs }).finally(() => this.pending.delete(key));
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
    let hadSession = false;
    let cleanExitMarked = false;
    if (spec.kind === "launch") {
      const profileDir = paths.profile(spec.name, spec.headless, spec.ignoreHTTPSErrors);
      // A profile that has been used before may restore last session's tabs.
      hadSession = fs.existsSync(path.join(profileDir, "Default"));
      let r;
      try {
        r = await launchBrowser(spec, this.log, { timeoutMs: opts.timeoutMs });
      } catch (err) {
        if (!/already running for/.test((err as Error)?.message ?? "")) throw err;
        // Chrome's ProcessSingleton says the profile is in use. Either a daemon
        // died without closing its Chrome (orphan: kill it and retry) or a live
        // owner still holds it (never kill; wait briefly, then fail clearly).
        const outcome = await reclaimProfile(profileDir, () => this.protectedPids(), this.log, {
          waitMs: Math.min(PROFILE_BUSY_WAIT_MS, Math.max(500, opts.timeoutMs - 2000)),
        });
        if (outcome !== "free") {
          throw new ProfileBusyError(
            `profile "${spec.name}" (${spec.headless ? "headless" : "headed"}) is in use by another Chrome (${outcome}). ` +
              `Stop it first (\`dev-browser stop ${spec.name}\`, or quit that Chrome), or use a different -b NAME.`,
          );
        }
        r = await launchBrowser(spec, this.log, { timeoutMs: opts.timeoutMs });
      }
      browser = r.browser;
      cleanExitMarked = r.cleanExitMarked;
      launched = true;
      wsEndpoint = browser.wsEndpoint();
    } else if (spec.kind === "cdp") {
      const r = await connectCdp(spec, this.log);
      browser = r.browser;
      wsEndpoint = r.resolved.wsEndpoint;
      // "9222", "http://127.0.0.1:9222" and "auto" may all be the same Chrome:
      // key the entry (and its page names) by the resolved ws endpoint.
      const canonical = canonicalCdpKey(wsEndpoint, spec.ignoreHTTPSErrors);
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
    // Pages reached through Puppeteer's own graph (page.browser().newPage(),
    // waitForTarget(...).page(), browserContext().pages(), popups) must carry
    // the dev-browser helpers too. Target.page() is cached per target, so extending
    // it here covers every later path to that Page.
    //
    // Launched browsers are dev-browser's own: every tab is extended eagerly. An
    // attached browser (--connect) belongs to the user: materializing a Page
    // for every tab they open would install dev-browser's dialog auto-dismiss and
    // load tracker in tabs no script ever touched. There, only popups whose
    // opener is a page dev-browser touched are extended eagerly; everything else
    // is extended lazily on first access (getPage by name/targetId, newPage).
    browser.on("targetcreated", (t: Target) => {
      if (t.type() !== "page") return;
      if (!launched && !entry.pages.isTouched(openerTargetId(t))) return;
      t.page()
        .then((p) => {
          if (p) entry.pages.adopt(p);
        })
        .catch(() => {});
    });
    const origNewPage = browser.newPage.bind(browser);
    (browser as { newPage: Browser["newPage"] }).newPage = async (...args) => entry.pages.adopt(await origNewPage(...args));

    if (launched) {
      // When the profile was marked as a clean exit, Chrome does not restore the
      // previous session, so no settle wait is needed (the sweep still runs).
      await closeRestoredTabs(browser, key, this.log, hadSession && !cleanExitMarked);
      for (const t of browser.targets()) {
        if (t.type() !== "page") continue;
        const id = (t as unknown as { _targetId?: string })._targetId;
        if (id) entry.pages.initialTargetIds.add(id);
      }
      await configureDownloads(browser, this.log);
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
      // Busy entries are touched when their run ends; waking for them now would
      // only re-arm a 50 ms timer until the script finishes.
      if (e.activeRuns > 0) continue;
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

/** Target id of a page target's opener (the page that called window.open), or null. */
function openerTargetId(t: Target): string | null {
  const opener = t.opener() as (Target & { _targetId?: string }) | undefined;
  if (opener && typeof opener._targetId === "string") return opener._targetId;
  return null;
}

/* ------------------------------------------------------------------ */
/* Launch-time housekeeping                                            */
/* ------------------------------------------------------------------ */

/**
 * A persistent profile restores last session's tabs on the next launch
 * (after `dev-browser stop`, a crash or a SIGKILLed daemon). Those tabs are
 * anonymous, accumulate across restarts and confuse `listPages()`, so close
 * them; keep (or create) one about:blank tab for getPage() to adopt.
 */
async function closeRestoredTabs(browser: Browser, name: string, log: FileLogger, hadSession: boolean): Promise<void> {
  const pageTargets = () => browser.targets().filter((t) => t.type() === "page");
  if (hadSession) {
    // Restored tabs trickle in after launch resolves; wait for target churn to
    // settle (no new page target for 200 ms, at most 1.5 s). Nothing else can
    // touch this browser yet: connect runs under the per-key mutex.
    const end = Date.now() + 1500;
    let count = pageTargets().length;
    let stableSince = Date.now();
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 50));
      const n = pageTargets().length;
      if (n !== count) {
        count = n;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 200) break;
    }
  }
  // Keep exactly one about:blank tab for getPage() to adopt; close the rest
  // (restored pages, and restored blank tabs, which look like the initial one).
  const pages = pageTargets();
  let keep = pages.find((t) => t.url() === "about:blank");
  if (!keep) {
    // Closing the last tab would close Chrome: open the blank tab first.
    try {
      keep = (await browser.newPage()).target();
    } catch (err) {
      log.warn(`launch ${name}: could not open a blank tab before closing restored tabs`, err);
      return;
    }
  }
  let closed = 0;
  for (const t of pages) {
    if (t === keep) continue;
    try {
      const p = await t.page();
      if (p && !p.isClosed()) {
        await p.close();
        closed++;
      }
    } catch {
      /* tab already gone */
    }
  }
  if (closed > 0) log.info(`launch ${name}: closed ${closed} tab(s) restored from the previous session`);
}

/**
 * Launched browsers download into ~/.dev-browser/v1/tmp/downloads instead of the
 * user's real ~/Downloads. Browser-level CDP; the session stays attached so
 * the behavior (and download events) persist for the life of the browser.
 */
async function configureDownloads(browser: Browser, log: FileLogger): Promise<void> {
  const dir = paths.downloads();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const session = await browser.target().createCDPSession();
    await session.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true });
  } catch (err) {
    log.warn(`could not set the download directory to ${dir}`, err);
  }
}

/* ------------------------------------------------------------------ */
/* Profile lock recovery                                               */
/* ------------------------------------------------------------------ */

/** Pids recorded by `dev-browser chrome` (the user's signed-in Chromes). */
export function chromePortPids(): number[] {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.chromePorts(), "utf8")) as Record<string, { pid?: number }>;
    return Object.values(raw)
      .map((v) => v.pid)
      .filter((p): p is number => Number.isInteger(p) && (p as number) > 1);
  } catch {
    return [];
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Command line of a process, or "" when unknown. */
export function commandLineOf(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    try {
      return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return "";
    }
  }
}

/** Parent pid of a process, or null when unknown. */
export function parentPidOf(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // "pid (comm) state ppid ..." and comm may contain spaces/parens.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(rest[1]);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    try {
      const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const ppid = Number(out.trim());
      return Number.isInteger(ppid) ? ppid : null;
    } catch {
      return null;
    }
  }
}

/** Pid recorded in Chrome's `<profile>/SingletonLock -> host-pid` symlink, or null. */
export function singletonLockPid(profileDir: string): number | null {
  try {
    const target = fs.readlinkSync(path.join(profileDir, "SingletonLock"));
    const pid = Number(target.slice(target.lastIndexOf("-") + 1));
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

export type LockHolder =
  | { kind: "none" }
  /** Lock points at a dead pid (or a different host): safe to clear. */
  | { kind: "stale"; pid: number }
  /** Live Chrome on this profile that nobody owns (its parent daemon is gone): safe to kill. */
  | { kind: "orphan"; pid: number }
  /** Live Chrome owned by this daemon or by `dev-browser chrome`: never touch. */
  | { kind: "ours"; pid: number }
  /** Live Chrome on this profile with a live parent that is not us (another daemon still closing it, a manual launch). */
  | { kind: "foreign"; pid: number; ppid: number | null }
  /** Our own child that is no longer a live entry (being closed by stop(), or dropped): wait, then kill. */
  | { kind: "child"; pid: number }
  /** Live process that does not reference this profile at all (pid reuse): leave it alone. */
  | { kind: "unrelated"; pid: number };

/**
 * Pure-ish safety predicate for profile lock recovery. `protectedPids` are
 * pids that must never be killed (live BrowserManager entries, `dev-browser
 * chrome` pids). `probe` is injectable for tests.
 */
export function classifyLockHolder(
  profileDir: string,
  protectedPids: Set<number>,
  probe: {
    lockPid?: (dir: string) => number | null;
    alive?: (pid: number) => boolean;
    cmdline?: (pid: number) => string;
    ppid?: (pid: number) => number | null;
    selfPid?: number;
  } = {},
): LockHolder {
  const pid = (probe.lockPid ?? singletonLockPid)(profileDir);
  if (pid === null) return { kind: "none" };
  if (!(probe.alive ?? pidAlive)(pid)) return { kind: "stale", pid };
  if (protectedPids.has(pid)) return { kind: "ours", pid };
  const cmdline = (probe.cmdline ?? commandLineOf)(pid);
  if (!cmdline.includes(profileDir)) return { kind: "unrelated", pid };
  const ppid = (probe.ppid ?? parentPidOf)(pid);
  const self = probe.selfPid ?? process.pid;
  // Reparented to init (or the parent vanished): an orphan from a dead daemon.
  if (ppid === null || ppid <= 1 || !(probe.alive ?? pidAlive)(ppid)) return { kind: "orphan", pid };
  if (ppid === self) return { kind: "child", pid };
  return { kind: "foreign", pid, ppid };
}

function clearSingletonFiles(profileDir: string): void {
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      fs.unlinkSync(path.join(profileDir, f));
    } catch {
      /* gone */
    }
  }
}

/**
 * Try to make a locked profile launchable. Returns "free" when the caller may
 * retry the launch, otherwise a short description of who holds it.
 *
 * - stale lock: clear the Singleton* files.
 * - orphan Chrome (parent daemon dead): SIGKILL it and wait for it to exit.
 * - ours / foreign: never kill. Wait up to `waitMs` for the holder to let go
 *   (a daemon that is shutting down closes its Chrome within a second or so),
 *   then give up.
 */
export async function reclaimProfile(
  profileDir: string,
  protectedPids: () => Set<number>,
  log: FileLogger,
  opts: { waitMs: number } = { waitMs: PROFILE_BUSY_WAIT_MS },
): Promise<"free" | string> {
  const deadline = Date.now() + opts.waitMs;
  const kill = async (pid: number): Promise<"free" | string> => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return `pid ${pid} could not be killed`;
    }
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      if (!pidAlive(pid)) {
        clearSingletonFiles(profileDir);
        return "free";
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return `pid ${pid} did not exit`;
  };
  for (;;) {
    const holder = classifyLockHolder(profileDir, protectedPids());
    switch (holder.kind) {
      case "none":
        // No lock yet Chrome said "already running": transient; let the caller retry.
        return "free";
      case "stale":
        log.warn(`clearing stale profile lock (pid ${holder.pid} is gone) on ${profileDir}`);
        clearSingletonFiles(profileDir);
        return "free";
      case "orphan":
        log.warn(`killing orphan Chrome pid ${holder.pid} holding ${profileDir}`);
        return kill(holder.pid);
      case "child":
        // Our own Chrome, mid-close or dropped. Give it time; kill only as a last resort.
        if (Date.now() >= deadline) {
          log.warn(`killing leftover Chrome child pid ${holder.pid} holding ${profileDir}`);
          return kill(holder.pid);
        }
        await new Promise((r) => setTimeout(r, 100));
        break;
      case "ours":
      case "foreign":
      case "unrelated":
        if (Date.now() >= deadline) {
          return holder.kind === "ours"
            ? `pid ${holder.pid}, owned by this daemon or \`dev-browser chrome\``
            : holder.kind === "foreign"
              ? `pid ${holder.pid}, parent pid ${holder.ppid}`
              : `pid ${holder.pid}`;
        }
        await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** @deprecated kept for callers/tests that only need the old boolean shape. */
export async function killOrphanChrome(profileDir: string, log: FileLogger, protectedPids: Set<number> = new Set()): Promise<boolean> {
  return (await reclaimProfile(profileDir, () => protectedPids, log, { waitMs: 0 })) === "free";
}
