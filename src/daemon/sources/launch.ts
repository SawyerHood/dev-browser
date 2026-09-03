/**
 * Launch source: a Chrome with a persistent named profile.
 */
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import type { LaunchSource } from "../../shared/protocol.ts";
import { paths } from "../../shared/paths.ts";
import { DEFAULTS } from "../../shared/config.ts";
import { findChrome, ChromeNotFoundError } from "../../shared/chrome.ts";
import type { FileLogger } from "../../shared/log.ts";

export const PROTOCOL_TIMEOUT_MS = 60_000;

export interface LaunchResult {
  browser: Browser;
  executablePath: string;
  /** True when the profile's Preferences were marked as a clean exit (no session restore expected). */
  cleanExitMarked: boolean;
}

/* ---------------- launch state cache (--no-sandbox) ---------------- */

interface LaunchState {
  /** Chrome binaries that need --no-sandbox on this machine. */
  noSandbox?: string[];
}

function launchStatePath(): string {
  return path.join(paths.home(), "launch-state.json");
}

function readLaunchState(): LaunchState {
  try {
    const v = JSON.parse(fs.readFileSync(launchStatePath(), "utf8")) as LaunchState;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function rememberNoSandbox(chromePath: string): void {
  try {
    const st = readLaunchState();
    const set = new Set(st.noSandbox ?? []);
    set.add(chromePath);
    fs.writeFileSync(launchStatePath(), JSON.stringify({ ...st, noSandbox: [...set] }, null, 2), { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

export function needsNoSandbox(chromePath: string): boolean {
  return (readLaunchState().noSandbox ?? []).includes(chromePath);
}

/**
 * Profile preferences dev-browser enforces before every launch:
 * - exit_type "Normal": Chrome restores the previous session when the last
 *   exit was not clean, and Puppeteer's close path often leaves "Crashed".
 * - password-leak detection OFF: after a login with a publicly leaked
 *   credential (every demo site), new-headless Chrome shows a tab-modal
 *   "password found in a data breach" dialog that silently swallows all CDP
 *   mouse/keyboard input for the rest of the page's life.
 * - no save-password bubble, no autofill popups: browser widgets that can
 *   take keyboard focus away from the page (Playwright's headless shell has
 *   no such UI; Chrome's --headless=new does).
 * Returns true when the file was written (or created for a fresh profile).
 */
export function preparePrefs(userDataDir: string): boolean {
  const dir = path.join(userDataDir, "Default");
  const prefs = path.join(dir, "Preferences");
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(fs.readFileSync(prefs, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false; // unreadable/corrupt: leave it
    json = {};
  }
  try {
    const profile = (json.profile ?? {}) as Record<string, unknown>;
    json.profile = { ...profile, exit_type: "Normal", exited_cleanly: true, password_manager_leak_detection: false, password_manager_enabled: false };
    json.credentials_enable_service = false;
    json.credentials_enable_autosignin = false;
    const autofill = (json.autofill ?? {}) as Record<string, unknown>;
    json.autofill = { ...autofill, profile_enabled: false, credit_card_enabled: false };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(prefs, JSON.stringify(json));
    return true;
  } catch {
    return false;
  }
}

/** @deprecated use preparePrefs */
export const markCleanExit = preparePrefs;

export function isSandboxError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /No usable sandbox|zygote_host|--no-sandbox|Failed to move to new namespace/i.test(msg);
}

export async function launchBrowser(
  spec: LaunchSource,
  log: FileLogger,
  opts: { timeoutMs: number },
): Promise<LaunchResult> {
  const chrome = findChrome();
  if (!chrome) throw new ChromeNotFoundError();
  const userDataDir = paths.profile(spec.name, spec.headless, spec.ignoreHTTPSErrors);
  const baseArgs = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    // Restored sessions are closed by BrowserManager; never show the bubble.
    "--hide-crash-restore-bubble",
  ];
  if (!spec.headless) baseArgs.push("--window-size=1280,900");
  const isRoot = os.platform() === "linux" && typeof process.getuid === "function" && process.getuid() === 0;

  const attempt = async (extra: string[]): Promise<Browser> =>
    puppeteer.launch({
      executablePath: chrome.path,
      headless: spec.headless,
      userDataDir,
      defaultViewport: spec.headless ? DEFAULTS.headlessViewport : null,
      acceptInsecureCerts: spec.ignoreHTTPSErrors === true,
      args: [...baseArgs, ...extra],
      protocolTimeout: PROTOCOL_TIMEOUT_MS,
      timeout: Math.max(1000, Math.min(opts.timeoutMs, 60_000)),
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });

  const t0 = Date.now();
  const cleanExitMarked = preparePrefs(userDataDir);
  const noSandbox = isRoot || needsNoSandbox(chrome.path);
  let browser: Browser;
  try {
    browser = await attempt(noSandbox ? ["--no-sandbox"] : []);
  } catch (err) {
    if (!noSandbox && isSandboxError(err)) {
      log.warn(`launch ${spec.name}: sandbox unavailable, retrying with --no-sandbox (remembered for ${chrome.path})`);
      browser = await attempt(["--no-sandbox"]);
      rememberNoSandbox(chrome.path);
    } else {
      throw err;
    }
  }
  log.info(`launched ${spec.name} (${spec.headless ? "headless" : "headed"}${spec.ignoreHTTPSErrors ? ", insecure certs accepted" : ""}) in ${Date.now() - t0}ms`, {
    chrome: chrome.path,
    source: chrome.source,
    profile: userDataDir,
  });
  return { browser, executablePath: chrome.path, cleanExitMarked };
}
