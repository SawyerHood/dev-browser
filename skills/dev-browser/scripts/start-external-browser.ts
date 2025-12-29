/**
 * Start dev-browser server connecting to an external browser via CDP.
 *
 * This mode is ideal for:
 * - Chrome for Testing or other specific browser builds
 * - Development workflows where you want the browser visible
 * - Keeping the browser open after automation for manual inspection
 *
 * Environment variables:
 *   PORT         - HTTP API port (default: 9222)
 *   CDP_PORT     - Browser's CDP port (default: 9223)
 *   BROWSER_PATH - Path to browser executable (for auto-launch)
 *   USER_DATA_DIR - Browser profile directory (default: ~/.dev-browser-profile)
 *   AUTO_LAUNCH  - Whether to auto-launch browser if not running (default: true)
 *
 * Example with Chrome for Testing:
 *   BROWSER_PATH="/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
 *   npx tsx scripts/start-external-browser.ts
 */

import { serveWithExternalBrowser } from "@/external-browser.js";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = join(__dirname, "..", "tmp");

// Create tmp directory if it doesn't exist
console.log("Creating tmp directory...");
mkdirSync(tmpDir, { recursive: true });

// Configuration from environment
const port = parseInt(process.env.PORT || "9222", 10);
const cdpPort = parseInt(process.env.CDP_PORT || "9223", 10);
const browserPath = process.env.BROWSER_PATH;
const userDataDir = process.env.USER_DATA_DIR || `${process.env.HOME}/.dev-browser-profile`;
const autoLaunch = process.env.AUTO_LAUNCH !== "false";

console.log("Starting dev-browser with external browser mode...");
console.log(`  HTTP API port: ${port}`);
console.log(`  CDP port: ${cdpPort}`);
if (browserPath) {
  console.log(`  Browser path: ${browserPath}`);
}
console.log(`  User data dir: ${userDataDir}`);
console.log(`  Auto-launch: ${autoLaunch}`);
console.log("");

// Check if our HTTP API server is already running
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

const server = await serveWithExternalBrowser({
  port,
  cdpPort,
  browserPath,
  userDataDir,
  autoLaunch,
});

console.log(`\nDev browser server started`);
console.log(`  WebSocket: ${server.wsEndpoint}`);
console.log(`  Mode: ${server.mode}`);
console.log(`  Tmp directory: ${tmpDir}`);
console.log(`\nReady`);
console.log(`\nPress Ctrl+C to stop (browser will remain open)`);

// Keep the process running
await new Promise(() => {});
