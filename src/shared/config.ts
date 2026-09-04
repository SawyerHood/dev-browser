/**
 * User config at ~/.dev-browser/v1/config.json and duration parsing.
 *
 * Precedence for every setting: CLI flag > environment > config.json > default.
 */

import { paths, lazyFs } from "./paths.ts";

export interface DevBrowserConfig {
  /** Default window mode for launched browsers. */
  headless?: boolean;
  /** Browser idle timeout: "30m", "5m", "0", or ms as a number. */
  idleTimeout?: string | number;
  /** Absolute path to a Chrome/Chromium executable. */
  chrome?: string;
  /** Default request deadline in seconds. */
  timeout?: number;
  /** Accept self-signed / invalid TLS certificates by default (`--ignore-https-errors`). */
  ignoreHttpsErrors?: boolean;
}

export const DEFAULTS = {
  timeoutSeconds: 30,
  idleTimeoutMs: 30 * 60 * 1000,
  daemonIdleExitMs: 15 * 60 * 1000,
  actionTimeoutMs: 5000,
  navigationTimeoutMs: 15000,
  outputCapChars: 50_000,
  outputHeadChars: 40_000,
  outputTailChars: 5_000,
  pageConsoleMaxLines: 20,
  snapshotMaxChars: 20_000,
  shotMaxEdge: 1568,
  shotQuality: 80,
  waitForLoadTimeoutMs: 3000,
  headlessViewport: { width: 1280, height: 720 },
};

export function loadConfig(): DevBrowserConfig {
  try {
    const raw = lazyFs().readFileSync(paths.config(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as DevBrowserConfig;
  } catch {
    /* missing or invalid config is the same as empty */
  }
  return {};
}

/** Same as loadConfig but via Bun.file (no node:fs on the client's hot path). */
export async function loadConfigAsync(): Promise<DevBrowserConfig> {
  try {
    const parsed = (await Bun.file(paths.config()).json()) as unknown;
    if (parsed && typeof parsed === "object") return parsed as DevBrowserConfig;
  } catch {
    /* missing or invalid config is the same as empty */
  }
  return {};
}

/**
 * Parse "30s" | "5m" | "1h" | "0" | "1500" (ms) | "1500ms" into milliseconds.
 * Throws on garbage.
 */
export function parseDuration(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) throw new Error(`invalid duration ${input}`);
    return Math.floor(input);
  }
  const s = String(input).trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(s);
  if (!m) throw new Error(`invalid duration "${input}" (use 30s, 5m, 1h, or milliseconds)`);
  const n = parseFloat(m[1]!);
  const unit = m[2] ?? "ms";
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.floor(n * mult);
}

export function formatDuration(ms: number): string {
  if (ms === 0) return "off";
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/** Resolve the idle timeout from flag/env/config/default. */
export function resolveIdleTimeoutMs(flag: string | undefined, config: DevBrowserConfig): number {
  if (flag !== undefined) return parseDuration(flag);
  // DEV_BROWSER_IDLE_TIMEOUT_MS was the documented 0.2.x name. Keep it as a
  // fallback so shell configuration survives the major-version upgrade.
  const env = process.env.DEV_BROWSER_IDLE_TIMEOUT || process.env.DEV_BROWSER_IDLE_TIMEOUT_MS;
  if (env !== undefined && env !== "") return parseDuration(env);
  if (config.idleTimeout !== undefined) return parseDuration(config.idleTimeout);
  return DEFAULTS.idleTimeoutMs;
}
