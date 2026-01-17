#!/usr/bin/env npx tsx
/**
 * Memory benchmark: Compare Playwright client vs HTTP-only client
 *
 * Measures heap memory usage for:
 * 1. Baseline (no imports)
 * 2. client-lite (HTTP-only, no Playwright)
 * 3. Full Playwright import
 *
 * Run: npx tsx scripts/memory-benchmark.ts
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getHeapUsed(): number {
  global.gc?.(); // Force GC if available
  return process.memoryUsage().heapUsed;
}

async function measureImport(name: string, importFn: () => Promise<unknown>): Promise<number> {
  global.gc?.();
  const before = getHeapUsed();
  await importFn();
  global.gc?.();
  const after = getHeapUsed();
  return after - before;
}

async function main() {
  console.log("=== Memory Benchmark: client-lite vs Playwright ===\n");

  // Check if GC is exposed
  if (!global.gc) {
    console.log("Note: Run with --expose-gc for accurate measurements");
    console.log("Example: node --expose-gc --import tsx scripts/memory-benchmark.ts\n");
  }

  const baseline = getHeapUsed();
  console.log(`Baseline heap: ${formatBytes(baseline)}\n`);

  // Measure client-lite import (HTTP-only)
  console.log("1. Importing client-lite (HTTP-only)...");
  const clientLiteMemory = await measureImport("client-lite", async () => {
    const { connectLite } = await import("../src/client-lite.js");
    // Create client instance to ensure full initialization
    const client = await connectLite("http://localhost:9222");
    return client;
  });
  console.log(`   Memory added: ${formatBytes(clientLiteMemory)}`);

  // Force new process measurement for Playwright to avoid module caching effects
  console.log("\n2. Importing Playwright (full client)...");
  const playwrightMemory = await measureImport("playwright", async () => {
    const { chromium } = await import("playwright");
    return chromium;
  });
  console.log(`   Memory added: ${formatBytes(playwrightMemory)}`);

  // Calculate savings
  console.log("\n=== Results ===");
  console.log(`client-lite memory:  ${formatBytes(clientLiteMemory)}`);
  console.log(`Playwright memory:   ${formatBytes(playwrightMemory)}`);

  if (playwrightMemory > clientLiteMemory) {
    const savings = playwrightMemory - clientLiteMemory;
    const percentage = ((savings / playwrightMemory) * 100).toFixed(1);
    console.log(`\nSavings: ${formatBytes(savings)} (${percentage}% reduction)`);
  }

  // Also measure full client.ts import for comparison
  console.log("\n3. Importing full client.ts (with Playwright)...");
  const fullClientMemory = await measureImport("client", async () => {
    const { connect } = await import("../src/client.js");
    return connect;
  });
  console.log(`   Memory added: ${formatBytes(fullClientMemory)}`);

  console.log("\n=== Summary ===");
  console.log("┌─────────────────────┬──────────────┐");
  console.log("│ Import              │ Memory       │");
  console.log("├─────────────────────┼──────────────┤");
  console.log(`│ client-lite         │ ${formatBytes(clientLiteMemory).padStart(12)} │`);
  console.log(`│ Playwright only     │ ${formatBytes(playwrightMemory).padStart(12)} │`);
  console.log(`│ Full client.ts      │ ${formatBytes(fullClientMemory).padStart(12)} │`);
  console.log("└─────────────────────┴──────────────┘");

  // Per-agent impact
  console.log("\n=== Per-Agent Impact (10 agents) ===");
  const agents = 10;
  console.log(`Full client (current):  ${formatBytes(fullClientMemory * agents)} total`);
  console.log(`client-lite (new):      ${formatBytes(clientLiteMemory * agents)} total`);
  if (fullClientMemory > clientLiteMemory) {
    const totalSavings = (fullClientMemory - clientLiteMemory) * agents;
    console.log(`Savings with 10 agents: ${formatBytes(totalSavings)}`);
  }
}

main().catch(console.error);
