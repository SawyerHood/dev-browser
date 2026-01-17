/**
 * Port management for multi-agent concurrency support.
 *
 * When multiple Claude Code agents (or other automation tools) run dev-browser
 * concurrently, each needs its own HTTP API server port while potentially
 * sharing the same browser instance.
 *
 * This module provides:
 * - Dynamic port allocation to avoid conflicts
 * - Server tracking for coordination
 * - Orphaned browser detection and cleanup (crash recovery)
 * - Config file support for preferences
 * - PORT=XXXX output for agent discovery
 *
 * @see https://github.com/SawyerHood/dev-browser/pull/15#issuecomment-3698722432
 */

import { createServer } from "net";
import { execSync } from "child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";

/**
 * Browser mode selection.
 * - "auto": Detect Chrome for Testing, fall back to standalone (default)
 * - "external": Always use external browser via CDP (fail if not found)
 * - "standalone": Always use Playwright's built-in Chromium
 */
export type BrowserMode = "auto" | "external" | "standalone";

/**
 * Browser configuration for dev-browser.
 */
export interface BrowserConfig {
  /**
   * Browser mode selection (default: "auto")
   * - "auto": Detect Chrome for Testing, fall back to standalone
   * - "external": Always use external browser via CDP
   * - "standalone": Always use Playwright's built-in Chromium
   */
  mode: BrowserMode;
  /**
   * Path to browser executable or app bundle for external mode.
   * If not set, uses platform-specific defaults.
   *
   * On macOS, if the path ends with .app (an app bundle), dev-browser
   * automatically uses `open -a` for proper Dock icon integration.
   * The app should handle CDP flags internally.
   *
   * Examples:
   * - macOS app bundle: /Applications/Chrome for Testing.app
   * - macOS binary: ~/.local/apps/Google Chrome for Testing.app/.../Google Chrome for Testing
   * - Linux: /opt/google/chrome-for-testing/chrome
   * - Windows: C:\Program Files\Google\Chrome for Testing\Application\chrome.exe
   */
  path?: string;
  /**
   * User data directory for browser profile.
   * Default: ~/.dev-browser-profile
   */
  userDataDir?: string;
  /**
   * Extra command-line arguments to pass to the browser.
   * Useful for environment-specific flags like --disable-gpu in WSL2.
   * Example: ["--disable-gpu", "--no-sandbox"]
   */
  extraArgs?: string[];
}

/**
 * Configuration for dev-browser multi-agent support.
 */
export interface DevBrowserConfig {
  /**
   * Port range for HTTP API servers.
   * Each concurrent agent gets a port from this range.
   */
  portRange: {
    /** First port to try (default: 9222) */
    start: number;
    /** Last port to try (default: 9300) */
    end: number;
    /** Port increment - use 2 to avoid CDP port collision (default: 2) */
    step: number;
  };
  /** CDP port for external browser mode (default: 9223) */
  cdpPort: number;
  /** Browser configuration */
  browser: BrowserConfig;
}

/**
 * Information about a registered server.
 */
export interface ServerInfo {
  /** Process ID of the server */
  pid: number;
  /** CDP port the server's browser is using (for orphan detection) */
  cdpPort?: number;
  /** Browser process ID (for standalone mode cleanup) */
  browserPid?: number;
  /** Server mode: 'standalone' owns browser, 'external' connects to shared browser */
  mode: "standalone" | "external";
  /** Timestamp when server was registered */
  startedAt: string;
}

/**
 * Get XDG config home directory.
 * Respects $XDG_CONFIG_HOME, falls back to ~/.config
 */
export function getXdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || join(process.env.HOME || "", ".config");
}

/**
 * Get XDG state home directory.
 * Respects $XDG_STATE_HOME, falls back to ~/.local/state
 */
export function getXdgStateHome(): string {
  return process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local", "state");
}

/**
 * Search for a config file by walking up the directory tree.
 * Looks for .dev-browser/config.json in each directory.
 *
 * @param startDir - Directory to start searching from (defaults to cwd)
 * @returns Path to config file if found, undefined otherwise
 */
export function findProjectConfig(startDir?: string): string | undefined {
  let dir = startDir || process.cwd();

  while (true) {
    const configPath = join(dir, ".dev-browser", "config.json");
    if (existsSync(configPath)) {
      return configPath;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      // Reached filesystem root (works on both Unix "/" and Windows "C:\")
      break;
    }
    dir = parent;
  }

  return undefined;
}

/**
 * Get the config file path using the following priority:
 * 1. DEV_BROWSER_CONFIG environment variable (explicit override)
 * 2. .dev-browser/config.json in cwd or ancestor directories (project config)
 * 3. $XDG_CONFIG_HOME/dev-browser/config.json (XDG compliant)
 * 4. ~/.config/dev-browser/config.json (XDG default)
 * 5. ~/.dev-browser/config.json (legacy fallback)
 *
 * @returns Path to config file and whether it exists
 */
export function getConfigFilePath(): { path: string; exists: boolean } {
  // 1. Explicit override via environment variable
  const envConfig = process.env.DEV_BROWSER_CONFIG;
  if (envConfig) {
    return { path: envConfig, exists: existsSync(envConfig) };
  }

  // 2. Project-level config (walk up directory tree)
  const projectConfig = findProjectConfig();
  if (projectConfig) {
    return { path: projectConfig, exists: true };
  }

  // 3. XDG config home
  const xdgConfig = join(getXdgConfigHome(), "dev-browser", "config.json");
  if (existsSync(xdgConfig)) {
    return { path: xdgConfig, exists: true };
  }

  // 4. XDG default (~/.config) - only if XDG_CONFIG_HOME is set to something else
  if (process.env.XDG_CONFIG_HOME) {
    const defaultXdgConfig = join(process.env.HOME || "", ".config", "dev-browser", "config.json");
    if (existsSync(defaultXdgConfig)) {
      return { path: defaultXdgConfig, exists: true };
    }
  }

  // 5. Legacy fallback
  const legacyConfig = join(process.env.HOME || "", ".dev-browser", "config.json");
  return { path: legacyConfig, exists: existsSync(legacyConfig) };
}

/**
 * Get the state directory for runtime state (active-servers.json, etc).
 * Uses XDG_STATE_HOME if available, falls back to legacy location.
 *
 * Priority:
 * 1. $XDG_STATE_HOME/dev-browser
 * 2. ~/.local/state/dev-browser
 * 3. ~/.dev-browser (legacy)
 */
export function getStateDir(): string {
  // Try XDG state home first
  const xdgStateDir = join(getXdgStateHome(), "dev-browser");

  // If XDG_STATE_HOME is explicitly set, use it
  if (process.env.XDG_STATE_HOME) {
    return xdgStateDir;
  }

  // Check if XDG default location exists or legacy exists
  const defaultXdgStateDir = join(process.env.HOME || "", ".local", "state", "dev-browser");
  const legacyDir = join(process.env.HOME || "", ".dev-browser");

  // Prefer XDG if the directory already exists there
  if (existsSync(defaultXdgStateDir)) {
    return defaultXdgStateDir;
  }

  // Fall back to legacy if it exists
  if (existsSync(legacyDir)) {
    return legacyDir;
  }

  // Default to XDG location for new installations
  return defaultXdgStateDir;
}

// Computed paths - these are functions now to support dynamic discovery
const getServersFile = () => join(getStateDir(), "active-servers.json");

/**
 * Get platform-specific default browser path for Chrome for Testing.
 */
function getDefaultBrowserPath(): string | undefined {
  const platform = process.platform;
  const homeDir = process.env.HOME || "";

  if (platform === "darwin") {
    // macOS: Check standard installation path
    const macPath = "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
    if (existsSync(macPath)) {
      return macPath;
    }
  } else if (platform === "linux") {
    // Linux: Check common installation paths
    const linuxPaths = [
      "/opt/google/chrome-for-testing/chrome",
      "/usr/bin/google-chrome-for-testing",
      "/usr/local/bin/chrome-for-testing",
    ];
    for (const path of linuxPaths) {
      if (existsSync(path)) {
        return path;
      }
    }
  } else if (platform === "win32") {
    // Windows: Check standard installation path
    const winPath = "C:\\Program Files\\Google\\Chrome for Testing\\Application\\chrome.exe";
    if (existsSync(winPath)) {
      return winPath;
    }
  }

  return undefined;
}

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: DevBrowserConfig = {
  portRange: {
    start: 19222, // High port range to avoid Chrome CDP port conflicts (9222-9223)
    end: 19300,
    step: 2, // Skip odd ports to avoid CDP port collision
  },
  cdpPort: 9223,
  browser: {
    mode: "auto",
    // userDataDir intentionally not set - let browser use its default profile
    // unless user explicitly configures it in ~/.dev-browser/config.json
  },
};

/**
 * Load configuration with defaults.
 * Merges user config with defaults and resolves platform-specific browser paths.
 *
 * Config file discovery priority:
 * 1. DEV_BROWSER_CONFIG environment variable
 * 2. .dev-browser/config.json in cwd or ancestor directories (project config)
 * 3. $XDG_CONFIG_HOME/dev-browser/config.json
 * 4. ~/.config/dev-browser/config.json
 * 5. ~/.dev-browser/config.json (legacy)
 */
export function loadConfig(): DevBrowserConfig {
  let config = { ...DEFAULT_CONFIG };

  const { path: configFile, exists } = getConfigFilePath();

  try {
    if (exists) {
      const content = readFileSync(configFile, "utf-8");
      const userConfig = JSON.parse(content);
      config = {
        ...DEFAULT_CONFIG,
        ...userConfig,
        portRange: {
          ...DEFAULT_CONFIG.portRange,
          ...(userConfig.portRange || {}),
        },
        browser: {
          ...DEFAULT_CONFIG.browser,
          ...(userConfig.browser || {}),
        },
      };
    }
  } catch (err) {
    console.warn(`Warning: Could not load config from ${configFile}:`, err);
  }

  // Resolve browser path: user config > auto-detection > undefined
  if (!config.browser.path) {
    config.browser.path = getDefaultBrowserPath();
  } else {
    // Validate user-specified path exists
    if (!existsSync(config.browser.path)) {
      console.warn(
        `Warning: Configured browser path does not exist: ${config.browser.path}\n` +
        `Falling back to auto-detection...`
      );
      config.browser.path = getDefaultBrowserPath();
    }
  }

  return config;
}

/**
 * Get resolved browser configuration for use by server scripts.
 * Returns the effective browser mode and path based on config and detection.
 */
export function getResolvedBrowserConfig(): {
  mode: "external" | "standalone";
  path?: string;
  userDataDir?: string;
  extraArgs?: string[];
} {
  const config = loadConfig();
  const { browser } = config;

  // Determine effective mode
  // IMPORTANT: We no longer fall back to standalone mode to prevent using Playwright's
  // bundled Chrome. Only the user's Chrome for Testing installation should be used.
  let effectiveMode: "external" | "standalone";

  if (browser.mode === "standalone") {
    // Standalone mode is explicitly requested - allow it but warn
    console.warn(
      `Warning: Standalone mode uses Playwright's bundled Chromium, not Chrome for Testing.\n` +
      `For consistent browser behavior, use mode "auto" or "external" with Chrome for Testing.`
    );
    effectiveMode = "standalone";
  } else if (browser.mode === "external") {
    if (!browser.path) {
      throw new Error(
        `Browser mode is "external" but no browser path configured or detected. ` +
        `Set browser.path in ~/.dev-browser/config.json or install Chrome for Testing.`
      );
    }
    effectiveMode = "external";
  } else {
    // "auto" mode: use external if browser found, otherwise FAIL (don't fall back to standalone)
    if (!browser.path) {
      throw new Error(
        `Chrome for Testing not found at standard locations.\n` +
        `Set browser.path in ~/.dev-browser/config.json to your Chrome executable or app bundle.`
      );
    }
    effectiveMode = "external";
  }

  return {
    mode: effectiveMode,
    path: browser.path,
    // Only include userDataDir if explicitly configured by user
    // For external mode, let the browser use its default profile unless specified
    userDataDir: browser.userDataDir,
    extraArgs: browser.extraArgs,
  };
}

/**
 * Check if a port is available by attempting to bind to it.
 * Checks both IPv4 and IPv6 to match Express's default binding behavior.
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  // Check default binding (IPv6 on most systems, which Express uses)
  const defaultAvailable = await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port);
  });

  if (!defaultAvailable) return false;

  // Also check IPv4 for completeness
  const ipv4Available = await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });

  return ipv4Available;
}

/**
 * Find an available port in the configured range.
 * @throws Error if no ports are available
 */
export async function findAvailablePort(config?: DevBrowserConfig): Promise<number> {
  const { portRange } = config || loadConfig();
  const { start, end, step } = portRange;

  for (let port = start; port < end; port += step) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(
    `No available ports in range ${start}-${end} (step ${step}). ` +
    `Too many dev-browser servers may be running. ` +
    `Check ~/.dev-browser/active-servers.json for active servers.`
  );
}

/**
 * Check if a process exists.
 */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the servers file, handling both old format (pid only) and new format (ServerInfo).
 */
function loadServersFile(): Record<string, ServerInfo> {
  const serversFile = getServersFile();
  if (!existsSync(serversFile)) {
    return {};
  }

  try {
    const content = readFileSync(serversFile, "utf-8");
    const data = JSON.parse(content);

    // Handle migration from old format { port: pid } to new format { port: ServerInfo }
    const servers: Record<string, ServerInfo> = {};
    for (const [port, value] of Object.entries(data)) {
      if (typeof value === "number") {
        // Old format: migrate to new format
        servers[port] = {
          pid: value,
          mode: "standalone", // Assume standalone for old entries
          startedAt: new Date().toISOString(),
        };
      } else {
        // New format
        servers[port] = value as ServerInfo;
      }
    }
    return servers;
  } catch {
    return {};
  }
}

/**
 * Save the servers file.
 */
function saveServersFile(servers: Record<string, ServerInfo>): void {
  const stateDir = getStateDir();
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(getServersFile(), JSON.stringify(servers, null, 2));
}

/**
 * Clean up stale entries from servers file (processes that no longer exist).
 */
function cleanupStaleEntries(servers: Record<string, ServerInfo>): Record<string, ServerInfo> {
  const cleaned: Record<string, ServerInfo> = {};
  for (const [port, info] of Object.entries(servers)) {
    if (processExists(info.pid)) {
      cleaned[port] = info;
    }
  }
  return cleaned;
}

/**
 * Register a server for coordination tracking.
 * This helps coordinate shutdown behavior and orphan detection.
 */
export function registerServer(
  port: number,
  pid: number,
  options?: {
    cdpPort?: number;
    browserPid?: number;
    mode?: "standalone" | "external";
  }
): void {
  mkdirSync(getStateDir(), { recursive: true });

  let servers = loadServersFile();
  servers = cleanupStaleEntries(servers);

  servers[port.toString()] = {
    pid,
    cdpPort: options?.cdpPort,
    browserPid: options?.browserPid,
    mode: options?.mode ?? "standalone",
    startedAt: new Date().toISOString(),
  };

  saveServersFile(servers);
}

/**
 * Unregister a server and return the count of remaining servers.
 */
export function unregisterServer(port: number): number {
  let servers = loadServersFile();
  delete servers[port.toString()];
  servers = cleanupStaleEntries(servers);
  saveServersFile(servers);
  return Object.keys(servers).length;
}

/**
 * Get the count of currently active servers.
 */
export function getActiveServerCount(): number {
  const servers = loadServersFile();
  const cleaned = cleanupStaleEntries(servers);
  return Object.keys(cleaned).length;
}

/**
 * Get process ID listening on a specific port (macOS/Linux).
 * Returns null if no process is listening or on error.
 */
function getProcessOnPort(port: number): number | null {
  try {
    // Works on macOS and Linux
    const output = execSync(`lsof -ti:${port}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (output) {
      // May return multiple PIDs, take the first one
      const firstLine = output.split("\n")[0] ?? "";
      const pid = parseInt(firstLine, 10);
      return isNaN(pid) ? null : pid;
    }
  } catch {
    // No process on port or lsof not available
  }
  return null;
}

/**
 * Information about an orphaned browser.
 */
export interface OrphanedBrowser {
  cdpPort: number;
  pid: number;
}

/**
 * Detect orphaned browsers - browsers running on CDP ports with no registered server.
 *
 * This handles crash recovery: if a server crashed without cleanup, its browser
 * may still be running. This function identifies such orphans.
 *
 * @param cdpPorts - CDP ports to check (default: common ports 9223, 9225, etc.)
 * @returns List of orphaned browsers
 */
export function detectOrphanedBrowsers(cdpPorts?: number[]): OrphanedBrowser[] {
  const servers = loadServersFile();
  const cleanedServers = cleanupStaleEntries(servers);

  // Get CDP ports that have active servers
  const activeCdpPorts = new Set<number>();
  for (const info of Object.values(cleanedServers)) {
    if (info.cdpPort) {
      activeCdpPorts.add(info.cdpPort);
    }
  }

  // Default ports to check if not specified
  const portsToCheck = cdpPorts ?? [9223, 9225, 9227, 9229, 9231];

  const orphans: OrphanedBrowser[] = [];
  for (const cdpPort of portsToCheck) {
    // Skip if an active server claims this CDP port
    if (activeCdpPorts.has(cdpPort)) {
      continue;
    }

    // Check if something is running on this port
    const pid = getProcessOnPort(cdpPort);
    if (pid !== null) {
      orphans.push({ cdpPort, pid });
    }
  }

  return orphans;
}

/**
 * Clean up orphaned browsers from previous crashed sessions.
 *
 * This is useful for standalone mode where the server owns the browser lifecycle.
 * Only kills processes that are truly orphaned (no registered server).
 *
 * @param cdpPorts - CDP ports to check for orphans
 * @returns Number of orphaned browsers cleaned up
 */
export function cleanupOrphanedBrowsers(cdpPorts?: number[]): number {
  const orphans = detectOrphanedBrowsers(cdpPorts);
  let cleaned = 0;

  for (const orphan of orphans) {
    try {
      console.log(
        `Cleaning up orphaned browser on CDP port ${orphan.cdpPort} (PID: ${orphan.pid})`
      );
      process.kill(orphan.pid, "SIGTERM");
      cleaned++;
    } catch (err) {
      console.warn(
        `Warning: Could not kill orphaned process ${orphan.pid}: ${err}`
      );
    }
  }

  return cleaned;
}

/**
 * Output the assigned port for agent discovery.
 * Agents parse this output to know which port to connect to.
 *
 * Format: PORT=XXXX
 */
export function outputPortForDiscovery(port: number): void {
  console.log(`PORT=${port}`);
}

/**
 * Write port to tmp/port file for client discovery.
 * The client-lite can read this file to find the server port.
 */
export function writePortFile(port: number, skillDir: string): void {
  const portFile = join(skillDir, "tmp", "port");
  mkdirSync(join(skillDir, "tmp"), { recursive: true });
  writeFileSync(portFile, port.toString());
}

/**
 * Read port from tmp/port file.
 * Returns null if file doesn't exist or is invalid.
 */
export function readPortFile(skillDir: string): number | null {
  const portFile = join(skillDir, "tmp", "port");
  try {
    if (existsSync(portFile)) {
      const content = readFileSync(portFile, "utf-8").trim();
      const port = parseInt(content, 10);
      return isNaN(port) ? null : port;
    }
  } catch {
    // File doesn't exist or can't be read
  }
  return null;
}

/**
 * Get the most recently started server from active-servers.json.
 * Returns null if no servers are running.
 */
export function getMostRecentServer(): { port: number; info: ServerInfo } | null {
  const servers = loadServersFile();
  const cleaned = cleanupStaleEntries(servers);

  // Save cleaned version back
  if (Object.keys(servers).length !== Object.keys(cleaned).length) {
    saveServersFile(cleaned);
  }

  let mostRecent: { port: number; info: ServerInfo } | null = null;
  let mostRecentTime = 0;

  for (const [portStr, info] of Object.entries(cleaned)) {
    const startedAt = new Date(info.startedAt).getTime();
    if (startedAt > mostRecentTime) {
      mostRecentTime = startedAt;
      mostRecent = { port: parseInt(portStr, 10), info };
    }
  }

  return mostRecent;
}

/**
 * Kill all stale servers (processes that no longer exist).
 * Called on startup to clean up zombies from crashed sessions.
 */
export function killStaleServers(): number {
  const servers = loadServersFile();
  let killed = 0;

  for (const [portStr, info] of Object.entries(servers)) {
    if (!processExists(info.pid)) {
      // Process doesn't exist, remove from registry
      delete servers[portStr];
      killed++;
    }
  }

  if (killed > 0) {
    saveServersFile(servers);
    console.log(`Cleaned up ${killed} stale server entries`);
  }

  return killed;
}
