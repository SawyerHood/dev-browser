/**
 * Find a Chrome/Chromium executable.
 *
 * Order: DEV_BROWSER_CHROME env > config.chrome > Chrome for Testing installed by
 * `dev-browser install` (~/.dev-browser/v1/chrome) > system Chrome/Chromium/Edge/Brave >
 * Playwright's cached Chromium (dev convenience).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { paths } from "./paths.ts";
import { loadConfig } from "./config.ts";

export interface ChromeCandidate {
  path: string;
  source: "env" | "config" | "installed" | "system" | "playwright";
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function whichAll(names: string[]): string[] {
  const out: string[] = [];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const p = path.join(dir, name);
      if (exists(p)) {
        out.push(p);
        break;
      }
    }
  }
  return out;
}

function systemCandidates(): string[] {
  const platform = os.platform();
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ].filter(exists);
  }
  if (platform === "linux") {
    return whichAll([
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "microsoft-edge",
      "microsoft-edge-stable",
      "brave-browser",
      "chrome",
    ]);
  }
  if (platform === "win32") {
    const roots = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env["LOCALAPPDATA"]].filter(
      Boolean,
    ) as string[];
    const rel = [
      "Google\\Chrome\\Application\\chrome.exe",
      "Chromium\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe",
    ];
    const out: string[] = [];
    for (const r of roots) for (const s of rel) {
      const p = path.join(r, s);
      if (exists(p)) out.push(p);
    }
    return out;
  }
  return [];
}

/** Binary names @puppeteer/browsers produces for Chrome for Testing. */
const CFT_BINARY_NAMES = new Set(["chrome", "chrome.exe", "Google Chrome for Testing"]);
/**
 * Deepest layout is macOS:
 *   chrome/mac_arm-<build>/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
 * = 6 directory levels below chromeDir (linux is 3). Keep a margin.
 */
const CFT_WALK_DEPTH = 8;

/** Chrome for Testing installed by `dev-browser install` via @puppeteer/browsers. */
export function installedCandidates(): string[] {
  const root = paths.chromeDir();
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > CFT_WALK_DEPTH) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (CFT_BINARY_NAMES.has(e.name) && exists(p)) out.push(p);
    }
  };
  walk(root, 0);
  return out.sort().reverse();
}

function playwrightCandidates(): string[] {
  const cache =
    os.platform() === "darwin"
      ? path.join(os.homedir(), "Library/Caches/ms-playwright")
      : path.join(os.homedir(), ".cache/ms-playwright");
  if (!fs.existsSync(cache)) return [];
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => parseInt(b.slice(9)) - parseInt(a.slice(9)));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of dirs) {
    const base = path.join(cache, d);
    const rel =
      os.platform() === "darwin"
        ? ["chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium"]
        : ["chrome-linux64/chrome", "chrome-linux/chrome"];
    for (const r of rel) {
      const p = path.join(base, r);
      if (exists(p)) out.push(p);
    }
  }
  return out;
}

/** All candidates in precedence order. */
export function listChromeCandidates(): ChromeCandidate[] {
  const out: ChromeCandidate[] = [];
  const env = process.env.DEV_BROWSER_CHROME;
  if (env && exists(env)) out.push({ path: env, source: "env" });
  const cfg = loadConfig().chrome;
  if (cfg && exists(cfg)) out.push({ path: cfg, source: "config" });
  for (const p of installedCandidates()) out.push({ path: p, source: "installed" });
  for (const p of systemCandidates()) out.push({ path: p, source: "system" });
  for (const p of playwrightCandidates()) out.push({ path: p, source: "playwright" });
  return out;
}

export function findChrome(): ChromeCandidate | null {
  return listChromeCandidates()[0] ?? null;
}

export class ChromeNotFoundError extends Error {
  constructor() {
    super(
      "No Chrome found. Run `dev-browser install` to download Chrome for Testing, " +
        "or set DEV_BROWSER_CHROME=/path/to/chrome, or put {\"chrome\": \"/path\"} in ~/.dev-browser/v1/config.json.",
    );
    this.name = "ChromeNotFoundError";
  }
}
