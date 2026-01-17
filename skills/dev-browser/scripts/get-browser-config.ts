/**
 * Output resolved browser configuration for shell scripts.
 *
 * Usage: npx tsx scripts/get-browser-config.ts
 *
 * Output format (shell-eval compatible):
 *   BROWSER_MODE="external"
 *   BROWSER_PATH="/path/to/chrome"
 *   BROWSER_USER_DATA_DIR="/path/to/profile"
 */

import { getResolvedBrowserConfig } from "@/config.js";

/**
 * Shell-escape a string value for safe eval.
 */
function shellEscape(value: string): string {
  // Use double quotes and escape special characters
  return `"${value.replace(/"/g, '\\"')}"`;
}

try {
  const config = getResolvedBrowserConfig();

  // Output in shell-eval format with proper quoting
  console.log(`BROWSER_MODE=${shellEscape(config.mode)}`);
  console.log(`BROWSER_PATH=${shellEscape(config.path || "")}`);
  // Only output userDataDir if explicitly configured
  console.log(`BROWSER_USER_DATA_DIR=${shellEscape(config.userDataDir || "")}`);
  // Output extraArgs as JSON array string (empty array if not configured)
  console.log(`BROWSER_EXTRA_ARGS=${shellEscape(JSON.stringify(config.extraArgs || []))}`);
} catch (err) {
  // On error, fail with clear message (don't fall back to standalone)
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
