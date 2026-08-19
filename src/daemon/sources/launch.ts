/**
 * Launch source: a Chrome with a persistent named profile.
 */
import * as os from "node:os";
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
}

function isSandboxError(err: unknown): boolean {
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
  const userDataDir = paths.profile(spec.name);
  const baseArgs = ["--no-first-run", "--no-default-browser-check", "--disable-search-engine-choice-screen"];
  if (!spec.headless) baseArgs.push("--window-size=1280,900");
  const isRoot = os.platform() === "linux" && typeof process.getuid === "function" && process.getuid() === 0;

  const attempt = async (extra: string[]): Promise<Browser> =>
    puppeteer.launch({
      executablePath: chrome.path,
      headless: spec.headless,
      userDataDir,
      defaultViewport: spec.headless ? DEFAULTS.headlessViewport : null,
      args: [...baseArgs, ...extra],
      protocolTimeout: PROTOCOL_TIMEOUT_MS,
      timeout: Math.max(1000, Math.min(opts.timeoutMs, 60_000)),
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });

  const t0 = Date.now();
  let browser: Browser;
  try {
    browser = await attempt(isRoot ? ["--no-sandbox"] : []);
  } catch (err) {
    if (!isRoot && isSandboxError(err)) {
      log.warn(`launch ${spec.name}: sandbox unavailable, retrying with --no-sandbox`);
      browser = await attempt(["--no-sandbox"]);
    } else {
      throw err;
    }
  }
  log.info(`launched ${spec.name} (${spec.headless ? "headless" : "headed"}) in ${Date.now() - t0}ms`, {
    chrome: chrome.path,
    source: chrome.source,
  });
  return { browser, executablePath: chrome.path };
}
