/**
 * Start dev-browser server connecting to an external browser via CDP.
 *
 * This mode is ideal for:
 * - Chrome for Testing or other specific browser builds
 * - Development workflows where you want the browser visible
 * - Keeping the browser open after automation for manual inspection
 * - Running multiple agents concurrently (each gets its own port automatically)
 *
 * Environment variables:
 *   PORT         - HTTP API port (default: auto-assigned from 9222-9300)
 *   CDP_PORT     - Browser's CDP port (default: 9223)
 *   BROWSER_PATH - Path to browser executable (for auto-launch)
 *   USER_DATA_DIR - Browser profile directory (default: ~/.dev-browser-profile)
 *   AUTO_LAUNCH  - Whether to auto-launch browser if not running (default: true)
 *
 * Configuration file: ~/.dev-browser/config.json
 *   {
 *     "portRange": { "start": 9222, "end": 9300, "step": 2 },
 *     "cdpPort": 9223
 *   }
 *
 * Example with Chrome for Testing:
 *   BROWSER_PATH="/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
 *   npx tsx scripts/start-external-browser.ts
 *
 * Multi-agent usage:
 *   # Terminal 1: First agent gets port 9222
 *   npx tsx scripts/start-external-browser.ts
 *   # Output: PORT=9222
 *
 *   # Terminal 2: Second agent gets port 9224
 *   npx tsx scripts/start-external-browser.ts
 *   # Output: PORT=9224
 *
 *   # Both agents share the same browser on CDP port 9223
 */

import { serveWithExternalBrowser } from "@/external-browser.js";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = join(__dirname, "..", "tmp");

// Create tmp directory if it doesn't exist
mkdirSync(tmpDir, { recursive: true });

// Configuration from environment (PORT is optional - will be auto-assigned)
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;
const cdpPort = process.env.CDP_PORT ? parseInt(process.env.CDP_PORT, 10) : undefined;
const browserPath = process.env.BROWSER_PATH;
// Only pass userDataDir if explicitly set - let browser use default profile otherwise
const userDataDir = process.env.USER_DATA_DIR || undefined;
// Parse extraArgs from JSON string (set by get-browser-config.ts)
const extraArgs = process.env.EXTRA_ARGS ? JSON.parse(process.env.EXTRA_ARGS) as string[] : undefined;
const autoLaunch = process.env.AUTO_LAUNCH !== "false";

console.log("Starting dev-browser with external browser mode...");
console.log(`  HTTP API port: ${port ?? "auto (dynamic)"}`);
console.log(`  CDP port: ${cdpPort ?? "from config (default: 9223)"}`);
if (browserPath) {
  console.log(`  Browser path: ${browserPath}`);
}
console.log(`  User data dir: ${userDataDir ?? "(default profile)"}`);
if (extraArgs?.length) {
  console.log(`  Extra args: ${extraArgs.join(" ")}`);
}
console.log(`  Auto-launch: ${autoLaunch}`);
console.log(`  Config: ~/.dev-browser/config.json`);
console.log("");

const server = await serveWithExternalBrowser({
  port,
  cdpPort,
  browserPath,
  userDataDir,
  extraArgs,
  autoLaunch,
});

console.log("");
console.log(`Dev browser server started`);
console.log(`  WebSocket: ${server.wsEndpoint}`);
console.log(`  HTTP API: http://localhost:${server.port}`);
console.log(`  Mode: ${server.mode}`);
console.log(`  Tmp directory: ${tmpDir}`);
console.log("");
console.log("Ready");
console.log("");
console.log("Press Ctrl+C to stop (browser will remain open)");

// Keep the process running
await new Promise(() => {});
