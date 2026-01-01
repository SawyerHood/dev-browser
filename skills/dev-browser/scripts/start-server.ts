/**
 * Start dev-browser server in standalone mode (launches Playwright Chromium).
 *
 * This mode:
 * - Launches a dedicated Playwright Chromium browser
 * - Owns the browser lifecycle (closes when server stops)
 * - Supports multiple concurrent agents via dynamic port allocation
 *
 * Environment variables:
 *   PORT     - HTTP API port (default: auto-assigned from 9222-9300)
 *   HEADLESS - Run browser in headless mode (default: false)
 *
 * Configuration file: ~/.dev-browser/config.json
 *   {
 *     "portRange": { "start": 9222, "end": 9300, "step": 2 },
 *     "cdpPort": 9223
 *   }
 *
 * Multi-agent usage:
 *   # Terminal 1: First agent gets port 9222, launches browser
 *   npx tsx scripts/start-server.ts
 *   # Output: PORT=9222
 *
 *   # Terminal 2: Second agent gets port 9224, launches separate browser
 *   npx tsx scripts/start-server.ts
 *   # Output: PORT=9224
 */

import { serve } from "@/index.js";
import { execSync } from "child_process";
import { mkdirSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = join(__dirname, "..", "tmp");
const profileDir = join(__dirname, "..", "profiles");

// Create tmp and profile directories if they don't exist
mkdirSync(tmpDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });

// Install Playwright browsers if not already installed
console.log("Checking Playwright browser installation...");

function findPackageManager(): { name: string; command: string } | null {
  const managers = [
    { name: "bun", command: "bunx playwright install chromium" },
    { name: "pnpm", command: "pnpm exec playwright install chromium" },
    { name: "npm", command: "npx playwright install chromium" },
  ];

  for (const manager of managers) {
    try {
      execSync(`which ${manager.name}`, { stdio: "ignore" });
      return manager;
    } catch {
      // Package manager not found, try next
    }
  }
  return null;
}

function isChromiumInstalled(): boolean {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const playwrightCacheDir = join(homeDir, ".cache", "ms-playwright");

  if (!existsSync(playwrightCacheDir)) {
    return false;
  }

  // Check for chromium directories (e.g., chromium-1148, chromium_headless_shell-1148)
  try {
    const entries = readdirSync(playwrightCacheDir);
    return entries.some((entry) => entry.startsWith("chromium"));
  } catch {
    return false;
  }
}

try {
  if (!isChromiumInstalled()) {
    console.log("Playwright Chromium not found. Installing (this may take a minute)...");

    const pm = findPackageManager();
    if (!pm) {
      throw new Error("No package manager found (tried bun, pnpm, npm)");
    }

    console.log(`Using ${pm.name} to install Playwright...`);
    execSync(pm.command, { stdio: "inherit" });
    console.log("Chromium installed successfully.");
  } else {
    console.log("Playwright Chromium already installed.");
  }
} catch (error) {
  console.error("Failed to install Playwright browsers:", error);
  console.log("You may need to run: npx playwright install chromium");
}

// Configuration from environment (PORT is optional - will be auto-assigned)
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;
const headless = process.env.HEADLESS === "true";

console.log("");
console.log("Starting dev browser server (standalone mode)...");
console.log(`  HTTP API port: ${port ?? "auto (dynamic)"}`);
console.log(`  Headless: ${headless}`);
console.log(`  Config: ~/.dev-browser/config.json`);
console.log("");

const server = await serve({
  port,
  headless,
  profileDir,
});

console.log("");
console.log(`Dev browser server started`);
console.log(`  WebSocket: ${server.wsEndpoint}`);
console.log(`  HTTP API: http://localhost:${server.port}`);
console.log(`  Tmp directory: ${tmpDir}`);
console.log(`  Profile directory: ${profileDir}`);
console.log("");
console.log("Ready");
console.log("");
console.log("Press Ctrl+C to stop");

// Keep the process running
await new Promise(() => {});
