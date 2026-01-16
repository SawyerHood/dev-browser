#!/usr/bin/env npx tsx
/**
 * Performance benchmark script for dev-browser
 *
 * Run before and after optimizations to measure impact:
 *   npx tsx scripts/benchmark.ts
 *
 * Requires Chrome for Testing running on CDP port 9223 (or 9222)
 */

import { performance } from "perf_hooks";

const CDP_PORT = process.env.CDP_PORT ? parseInt(process.env.CDP_PORT) : 9222;
const ITERATIONS = 5;

interface BenchmarkResult {
  name: string;
  avgMs: number;
  minMs: number;
  maxMs: number;
  samples: number[];
}

async function benchmark(name: string, fn: () => Promise<void>, iterations = ITERATIONS): Promise<BenchmarkResult> {
  const samples: number[] = [];

  // Warm-up run
  await fn();

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }

  return {
    name,
    avgMs: samples.reduce((a, b) => a + b, 0) / samples.length,
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
    samples,
  };
}

function formatResult(r: BenchmarkResult): string {
  return `${r.name}: ${r.avgMs.toFixed(1)}ms avg (${r.minMs.toFixed(1)}-${r.maxMs.toFixed(1)}ms)`;
}

// Helper to get last result (benchmark script, so we know array is populated)
function lastResult(arr: BenchmarkResult[]): BenchmarkResult {
  const last = arr[arr.length - 1];
  if (!last) throw new Error("No results");
  return last;
}

async function main() {
  console.log("=== Dev-Browser Performance Benchmark ===\n");
  console.log(`CDP Port: ${CDP_PORT}`);
  console.log(`Iterations: ${ITERATIONS}`);
  console.log("");

  // Check if Chrome is running
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (!res.ok) throw new Error("Chrome not responding");
    const info = await res.json() as { Browser: string };
    console.log(`Chrome: ${info.Browser}\n`);
  } catch {
    console.error(`ERROR: Chrome not running on port ${CDP_PORT}`);
    console.error("Start Chrome for Testing first, or set CDP_PORT env var");
    process.exit(1);
  }

  const results: BenchmarkResult[] = [];

  // Benchmark 1: Import time
  console.log("--- Import Benchmarks ---");

  results.push(await benchmark("Import playwright", async () => {
    // Dynamic import to measure fresh load time
    const mod = await import("playwright");
    // Force module to be used to prevent optimization
    if (!mod.chromium) throw new Error("No chromium");
  }, 3));
  console.log(formatResult(lastResult(results)));

  results.push(await benchmark("Import express", async () => {
    const mod = await import("express");
    if (!mod.default) throw new Error("No express");
  }, 3));
  console.log(formatResult(lastResult(results)));

  // Benchmark 2: CDP connection
  console.log("\n--- Connection Benchmarks ---");

  const { chromium } = await import("playwright");

  results.push(await benchmark("Connect to CDP", async () => {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    await browser.close();
  }));
  console.log(formatResult(lastResult(results)));

  // Benchmark 3: Page operations (with persistent connection)
  console.log("\n--- Page Operation Benchmarks ---");

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = browser.contexts()[0] || await browser.newContext();

  results.push(await benchmark("Create page", async () => {
    const page = await context.newPage();
    await page.close();
  }));
  console.log(formatResult(lastResult(results)));

  results.push(await benchmark("Create page + get targetId", async () => {
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    await session.send("Target.getTargetInfo");
    await session.detach();
    await page.close();
  }));
  console.log(formatResult(lastResult(results)));

  const testPage = await context.newPage();
  await testPage.goto("about:blank");

  results.push(await benchmark("page.evaluate (simple)", async () => {
    await testPage.evaluate(() => 1 + 1);
  }, 20));
  console.log(formatResult(lastResult(results)));

  results.push(await benchmark("page.evaluate (DOM access)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await testPage.evaluate(() => (globalThis as any).document.title);
  }, 20));
  console.log(formatResult(lastResult(results)));

  // Benchmark 4: Page lookup simulation
  console.log("\n--- Page Lookup Benchmarks ---");

  // Create 10 pages to simulate realistic scenario
  const pages: Array<{ page: Awaited<ReturnType<typeof context.newPage>>; targetId: string }> = [];
  for (let i = 0; i < 10; i++) {
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    const { targetInfo } = await session.send("Target.getTargetInfo") as { targetInfo: { targetId: string } };
    await session.detach();
    pages.push({ page, targetId: targetInfo.targetId });
  }

  const lastPage = pages[pages.length - 1];
  if (!lastPage) throw new Error("No pages created");
  const targetToFind = lastPage.targetId; // Worst case - last page

  results.push(await benchmark("Find page (current: CDP per page)", async () => {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        const session = await ctx.newCDPSession(p);
        const { targetInfo } = await session.send("Target.getTargetInfo") as { targetInfo: { targetId: string } };
        await session.detach();
        if (targetInfo.targetId === targetToFind) return;
      }
    }
  }));
  console.log(formatResult(lastResult(results)));

  // Optimized: Map lookup
  const pageMap = new Map(pages.map(p => [p.targetId, p.page]));

  results.push(await benchmark("Find page (optimized: Map)", async () => {
    const found = pageMap.get(targetToFind);
    if (!found) throw new Error("Not found");
  }, 100));
  console.log(formatResult(lastResult(results)));

  // Benchmark 5: Concurrent operations
  console.log("\n--- Concurrency Benchmarks ---");

  results.push(await benchmark("5 concurrent pages", async () => {
    const newPages = await Promise.all(
      Array(5).fill(0).map(() => context.newPage())
    );
    await Promise.all(newPages.map(p => p.close()));
  }, 3));
  console.log(formatResult(lastResult(results)));

  // Cleanup
  for (const { page } of pages) {
    await page.close();
  }
  await testPage.close();
  await browser.close();

  // Summary
  console.log("\n=== SUMMARY ===");
  console.log("Copy this for before/after comparison:\n");
  console.log("```");
  for (const r of results) {
    console.log(`${r.name.padEnd(40)} ${r.avgMs.toFixed(1).padStart(8)}ms`);
  }
  console.log("```");

  // Output as JSON for automated comparison
  const jsonOutput = {
    timestamp: new Date().toISOString(),
    cdpPort: CDP_PORT,
    iterations: ITERATIONS,
    results: results.map(r => ({
      name: r.name,
      avgMs: Math.round(r.avgMs * 10) / 10,
      minMs: Math.round(r.minMs * 10) / 10,
      maxMs: Math.round(r.maxMs * 10) / 10,
    })),
  };

  console.log("\nJSON (for automated comparison):");
  console.log(JSON.stringify(jsonOutput, null, 2));
}

main().catch(console.error);
