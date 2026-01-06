import { serve } from "@/index.js";
import { execSync } from "child_process";
import { mkdirSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = join(__dirname, "..", "tmp");
const profileDir = join(__dirname, "..", "profiles");

// Create tmp and profile directories if they don't exist
console.log("Creating tmp directory...");
mkdirSync(tmpDir, { recursive: true });
console.log("Creating profiles directory...");
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

// Parse port configuration from environment
const port = parseInt(process.env.PORT || "9222", 10);
const cdpPort = process.env.CDP_PORT ? parseInt(process.env.CDP_PORT, 10) : undefined;
const effectiveCdpPort = cdpPort || port + 1;

// Check if server is already running
console.log("Checking for existing servers...");
try {
  const res = await fetch(`http://localhost:${port}`, {
    signal: AbortSignal.timeout(1000),
  });
  if (res.ok) {
    console.log(`Server already running on port ${port}`);
    process.exit(0);
  }
} catch {
  // Server not running, continue to start
}

// Clean up stale CDP port if HTTP server isn't running (crash recovery)
// This handles the case where Node crashed but Chrome is still running
try {
  const pid = execSync(`lsof -ti:${effectiveCdpPort}`, { encoding: "utf-8" }).trim();
  if (pid) {
    console.log(`Cleaning up stale Chrome process on CDP port ${effectiveCdpPort} (PID: ${pid})`);
    execSync(`kill -9 ${pid}`);
  }
} catch {
  // No process on CDP port, which is expected
}

console.log("Starting dev browser server...");
const headless = process.env.HEADLESS === "true";
const server = await serve({
  port,
  cdpPort,
  headless,
  profileDir,
});

console.log(`Dev browser server started`);
console.log(`  WebSocket: ${server.wsEndpoint}`);
console.log(`  Tmp directory: ${tmpDir}`);
console.log(`  Profile directory: ${profileDir}`);
console.log(`\nReady`);
console.log(`\nPress Ctrl+C to stop`);

// Keep the process running
await new Promise(() => {});
