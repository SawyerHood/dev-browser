#!/usr/bin/env npx tsx
/**
 * Test script for HTTP-only API endpoints (Phase 2)
 *
 * Tests the new server endpoints that enable the lightweight client.
 * Requires a dev-browser server running on port 9222.
 */

const SERVER_URL = process.env.SERVER_URL || "http://localhost:9222";

async function jsonRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  return JSON.parse(text) as T;
}

async function main() {
  console.log("=== Testing HTTP-only API endpoints ===\n");
  console.log(`Server: ${SERVER_URL}`);

  // Check server is running
  try {
    const info = await jsonRequest<{ wsEndpoint: string; mode?: string }>("/");
    console.log(`Server mode: ${info.mode || "unknown"}`);
    console.log(`WebSocket endpoint: ${info.wsEndpoint}\n`);
  } catch (err) {
    console.error("ERROR: Server not running or not reachable");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const pageName = "test-http-api";

  try {
    // 1. Create page
    console.log("1. Creating page...");
    const pageInfo = await jsonRequest<{ name: string; targetId: string }>("/pages", {
      method: "POST",
      body: JSON.stringify({ name: pageName }),
    });
    console.log(`   Created page: ${pageInfo.name} (targetId: ${pageInfo.targetId.slice(0, 8)}...)`);

    // 2. Navigate
    console.log("2. Navigating to example.com...");
    const navResult = await jsonRequest<{ url: string; title: string }>(`/pages/${pageName}/navigate`, {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com" }),
    });
    console.log(`   URL: ${navResult.url}`);
    console.log(`   Title: ${navResult.title}`);

    // 3. Evaluate
    console.log("3. Evaluating JavaScript...");
    const evalResult = await jsonRequest<{ result: unknown }>(`/pages/${pageName}/evaluate`, {
      method: "POST",
      body: JSON.stringify({ expression: "document.title" }),
    });
    console.log(`   Result: ${evalResult.result}`);

    // 4. Get snapshot
    console.log("4. Getting AI snapshot...");
    const snapshotResult = await jsonRequest<{ snapshot: string }>(`/pages/${pageName}/snapshot`);
    const snapshotLines = snapshotResult.snapshot.split("\n");
    console.log(`   Snapshot lines: ${snapshotLines.length}`);
    console.log(`   First 3 lines:`);
    snapshotLines.slice(0, 3).forEach(line => console.log(`     ${line}`));

    // 5. Select ref (find a link)
    console.log("5. Selecting ref from snapshot...");
    const linkMatch = snapshotResult.snapshot.match(/\[ref=(e\d+)\]/);
    if (linkMatch) {
      const ref = linkMatch[1];
      const refResult = await jsonRequest<{ found: boolean; tagName?: string }>(`/pages/${pageName}/select-ref`, {
        method: "POST",
        body: JSON.stringify({ ref }),
      });
      console.log(`   Ref ${ref}: found=${refResult.found}, tag=${refResult.tagName}`);
    } else {
      console.log("   No refs found in snapshot");
    }

    // 6. Clean up
    console.log("6. Closing page...");
    await jsonRequest(`/pages/${pageName}`, { method: "DELETE" });
    console.log("   Page closed");

    console.log("\n=== All tests passed! ===");
  } catch (err) {
    console.error("\nERROR:", err instanceof Error ? err.message : String(err));
    // Try to clean up
    try {
      await jsonRequest(`/pages/${pageName}`, { method: "DELETE" });
    } catch {
      // Ignore cleanup errors
    }
    process.exit(1);
  }
}

main();
