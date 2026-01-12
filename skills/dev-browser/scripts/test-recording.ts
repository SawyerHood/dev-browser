/**
 * Integration test for video recording functionality.
 * Run with: npx tsx scripts/test-recording.ts
 *
 * Prerequisites:
 * - Server must be running: npm run start-server
 * - ffmpeg should be installed for video encoding (optional, falls back to frames)
 */

import { connect } from "@/client.js";
import { execSync } from "child_process";
import { existsSync, statSync, rmSync } from "fs";

async function testRecording() {
  console.log("=== Video Recording Integration Test ===\n");

  console.log("1. Connecting to server...");
  const client = await connect();
  console.log("   Connected!\n");

  console.log("2. Creating test page...");
  const page = await client.page("recording-test");
  await page.goto("https://example.com");
  console.log("   Page created and navigated to example.com\n");

  console.log("3. Starting recording...");
  await client.startRecording("recording-test");
  console.log("   Recording started!\n");

  console.log("4. Checking status...");
  let status = await client.getRecordingStatus("recording-test");
  if (!status.isRecording) {
    throw new Error("Recording should be active");
  }
  console.log(`   Status: isRecording=${status.isRecording}, startedAt=${status.startedAt}\n`);

  console.log("5. Performing actions (2 seconds)...");
  await page.click("body");
  await page.evaluate(() => {
    // Scroll to trigger some visual changes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).scrollTo(0, 100);
  });
  await new Promise((r) => setTimeout(r, 2000));

  status = await client.getRecordingStatus("recording-test");
  console.log(`   Captured ${status.frameCount} frames\n`);

  if ((status.frameCount ?? 0) < 10) {
    console.warn("   Warning: Expected more frames. CDP screencast may not be capturing.");
  }

  console.log("6. Testing duplicate start rejection...");
  try {
    await client.startRecording("recording-test");
    throw new Error("Should have rejected duplicate start");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("already in progress")) {
      console.log("   Correctly rejected duplicate start\n");
    } else {
      throw e;
    }
  }

  console.log("7. Stopping recording...");
  const { videoPath, durationMs, frameCount } = await client.stopRecording("recording-test");
  console.log(`   Video path: ${videoPath}`);
  console.log(`   Duration: ${durationMs}ms`);
  console.log(`   Frames: ${frameCount}\n`);

  console.log("8. Validating output...");
  if (!existsSync(videoPath)) {
    throw new Error(`Output not found: ${videoPath}`);
  }

  const stats = statSync(videoPath);
  const isDirectory = stats.isDirectory();
  const size = isDirectory ? 0 : stats.size;

  if (isDirectory) {
    console.log(`   Output is a frames directory (ffmpeg not available)`);
  } else {
    console.log(`   File size: ${(size / 1024).toFixed(1)}KB`);

    if (size < 100) {
      throw new Error(`Output too small: ${size} bytes`);
    }

    // Try to validate with ffprobe if available
    console.log("\n9. Checking video with ffprobe...");
    try {
      const probe = execSync(`ffprobe -v error -show_format "${videoPath}"`, {
        encoding: "utf-8",
      });
      if (probe.includes("format_name=")) {
        console.log("   Video format validated with ffprobe");
      }
    } catch {
      console.log("   ffprobe not available, skipping codec validation");
    }
  }

  console.log("\n10. Testing stop without start rejection...");
  try {
    await client.stopRecording("recording-test");
    throw new Error("Should have rejected stop without start");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("No recording in progress")) {
      console.log("    Correctly rejected stop without start\n");
    } else {
      throw e;
    }
  }

  console.log("11. Cleaning up...");
  // Clean up the test video/frames
  try {
    rmSync(videoPath, { recursive: true });
    console.log("    Removed test output\n");
  } catch {
    console.log("    Could not remove test output (may need manual cleanup)\n");
  }

  // Close the test page
  await client.close("recording-test");
  await client.disconnect();

  console.log("=================================");
  console.log("✅ ALL CHECKS PASSED");
  console.log("=================================\n");

  console.log("Summary:");
  console.log(`  - Recording started/stopped successfully`);
  console.log(`  - Captured ${frameCount} frames in ${durationMs}ms`);
  console.log(`  - Error cases handled correctly`);
  console.log(`  - Output: ${videoPath}`);
}

testRecording().catch((e) => {
  console.error("\n=================================");
  console.error("❌ TEST FAILED:", e.message);
  console.error("=================================\n");
  process.exit(1);
});
