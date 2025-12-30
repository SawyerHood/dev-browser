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
 * - Config file support for preferences
 * - PORT=XXXX output for agent discovery
 *
 * @see https://github.com/SawyerHood/dev-browser/pull/15#issuecomment-3698722432
 */

import { createServer } from "net";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

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
}

const CONFIG_DIR = join(process.env.HOME || "", ".dev-browser");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const SERVERS_FILE = join(CONFIG_DIR, "active-servers.json");

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: DevBrowserConfig = {
  portRange: {
    start: 9222,
    end: 9300,
    step: 2, // Skip odd ports to avoid CDP port collision
  },
  cdpPort: 9223,
};

/**
 * Load configuration from ~/.dev-browser/config.json with defaults.
 */
export function loadConfig(): DevBrowserConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const content = readFileSync(CONFIG_FILE, "utf-8");
      const userConfig = JSON.parse(content);
      return {
        ...DEFAULT_CONFIG,
        ...userConfig,
        portRange: {
          ...DEFAULT_CONFIG.portRange,
          ...(userConfig.portRange || {}),
        },
      };
    }
  } catch (err) {
    console.warn(`Warning: Could not load config from ${CONFIG_FILE}:`, err);
  }
  return DEFAULT_CONFIG;
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
 * Register a server for coordination tracking.
 * This helps coordinate shutdown behavior across multiple servers.
 */
export function registerServer(port: number, pid: number): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  let servers: Record<number, number> = {};

  try {
    if (existsSync(SERVERS_FILE)) {
      servers = JSON.parse(readFileSync(SERVERS_FILE, "utf-8"));
    }
  } catch {
    servers = {};
  }

  // Clean up stale entries (processes that no longer exist)
  for (const [portStr, serverPid] of Object.entries(servers)) {
    try {
      process.kill(serverPid as number, 0); // Check if process exists
    } catch {
      delete servers[parseInt(portStr)];
    }
  }

  servers[port] = pid;
  writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2));
}

/**
 * Unregister a server and return the count of remaining servers.
 */
export function unregisterServer(port: number): number {
  let servers: Record<number, number> = {};

  try {
    if (existsSync(SERVERS_FILE)) {
      servers = JSON.parse(readFileSync(SERVERS_FILE, "utf-8"));
    }
  } catch {
    servers = {};
  }

  delete servers[port];

  // Clean up stale entries
  for (const [portStr, serverPid] of Object.entries(servers)) {
    try {
      process.kill(serverPid as number, 0);
    } catch {
      delete servers[parseInt(portStr)];
    }
  }

  writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2));
  return Object.keys(servers).length;
}

/**
 * Get the count of currently active servers.
 */
export function getActiveServerCount(): number {
  try {
    if (!existsSync(SERVERS_FILE)) {
      return 0;
    }

    const servers: Record<number, number> = JSON.parse(
      readFileSync(SERVERS_FILE, "utf-8")
    );

    // Count only servers that are still running
    let count = 0;
    for (const serverPid of Object.values(servers)) {
      try {
        process.kill(serverPid as number, 0);
        count++;
      } catch {
        // Process no longer exists
      }
    }
    return count;
  } catch {
    return 0;
  }
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
