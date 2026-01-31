/**
 * Shared constants for the extension.
 */

export const DEFAULT_RELAY_URL = "ws://localhost:9222/extension";

/**
 * Convert a WebSocket URL to an HTTP URL for health checks.
 * Handles both ws:// -> http:// and wss:// -> https:// conversions.
 */
export function wsUrlToHttpUrl(wsUrl: string): string {
  try {
    const url = new URL(wsUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    // Fallback for invalid URLs
    return wsUrl
      .replace(/^wss:/, "https:")
      .replace(/^ws:/, "http:")
      .replace(/\/extension$/, "");
  }
}

/**
 * Validate a WebSocket URL.
 * Returns null if valid, or an error message if invalid.
 */
export function validateRelayUrl(url: string): string | null {
  if (!url) {
    return "URL cannot be empty";
  }

  if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    return "URL must start with ws:// or wss://";
  }

  try {
    new URL(url);
  } catch {
    return "Invalid URL format";
  }

  return null;
}
