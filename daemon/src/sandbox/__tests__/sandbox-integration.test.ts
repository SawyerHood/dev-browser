import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "../../browser-manager.js";
import { formatError } from "../../format-error.js";
import { removeDirectoryWithRetries } from "../../test-cleanup.js";
import { runScript } from "../script-runner-quickjs.js";
import { ensureSandboxClientBundle } from "./bundle-test-helpers.js";

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
}

function createOutput(): CapturedOutput & {
  sink: {
    onStdout: (data: string) => void;
    onStderr: (data: string) => void;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    sink: {
      onStdout: (data) => {
        stdout.push(data);
      },
      onStderr: (data) => {
        stderr.push(data);
      },
    },
  };
}

describe.sequential("QuickJS sandbox integration", () => {
  let browserRootDir = "";
  let manager: BrowserManager;

  beforeAll(async () => {
    await ensureSandboxClientBundle();

    browserRootDir = await mkdtemp(path.join(os.tmpdir(), "dev-browser-quickjs-"));
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
    await manager.ensureBrowser("default", {
      headless: true,
    });
  }, 180_000);

  afterAll(async () => {
    await manager.stopAll();
    await removeDirectoryWithRetries(browserRootDir);
  }, 180_000);

  it("navigates through QuickJS and logs the page title", async () => {
    const output = createOutput();

    await runScript(
      `
        const page = await browser.getPage("nav");
        await page.goto("https://example.com");
        console.log(await page.title());
      `,
      manager,
      "default",
      output.sink,
      {
        timeout: 60_000,
      }
    );

    expect(output.stdout.join("")).toContain("Example Domain");
    expect(output.stderr.join("")).toBe("");
  }, 120_000);

  it("supports locator operations", async () => {
    const output = createOutput();

    await runScript(
      `
        const page = await browser.getPage("locator");
        await page.goto("https://example.com");
        console.log(await page.locator("h1").textContent());
      `,
      manager,
      "default",
      output.sink,
      {
        timeout: 60_000,
      }
    );

    expect(output.stdout.join("")).toContain("Example Domain");
  }, 120_000);

  it("supports page.evaluate", async () => {
    const output = createOutput();

    await runScript(
      `
        const page = await browser.getPage("evaluate");
        await page.goto("https://example.com");
        console.log(await page.evaluate(() => document.title));
      `,
      manager,
      "default",
      output.sink,
      {
        timeout: 60_000,
      }
    );

    expect(output.stdout.join("")).toContain("Example Domain");
  }, 120_000);

  it("reports thrown script errors", async () => {
    const output = createOutput();

    await expect(
      runScript(
        `
          throw new Error("boom");
        `,
        manager,
        "default",
        output.sink
      )
    ).rejects.toThrow("boom");
  });

  it("surfaces thrown error messages in formatted errors", async () => {
    const output = createOutput();

    const error = await runScript(
      `
        throw new Error("boom message");
      `,
      manager,
      "default",
      output.sink
    ).then(
      () => null,
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(Error);
    expect(formatError(error)).toContain("boom message");
  });

  it("enforces CPU timeouts", async () => {
    const output = createOutput();

    await expect(
      runScript(
        `
          while (true) {}
        `,
        manager,
        "default",
        output.sink,
        {
          timeout: 25,
        }
      )
    ).rejects.toThrow(/timed out|interrupted/i);
  }, 120_000);

  it("enforces wall-clock timeouts for async scripts", async () => {
    const output = createOutput();

    await expect(
      runScript(
        `
          await new Promise((resolve) => setTimeout(resolve, 100));
        `,
        manager,
        "default",
        output.sink,
        {
          timeout: 25,
        }
      )
    ).rejects.toThrow(/timed out|terminated|interrupted/i);
  }, 120_000);

  it("stops pending Playwright operations on abort before reusing the browser", async () => {
    const controller = new AbortController();
    let announceReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      announceReady = resolve;
    });
    const firstOutput = createOutput();
    const onStdout = firstOutput.sink.onStdout;
    firstOutput.sink.onStdout = (data) => {
      onStdout(data);
      if (data.includes("waiting")) announceReady();
    };

    const blocked = runScript(
      `
        const page = await browser.getPage("abort-reuse");
        await page.setContent("<button id='ok'>Ready</button>");
        console.log("waiting");
        await page.locator("#never").click({ timeout: 60000 });
        console.log("late");
      `,
      manager,
      "default",
      firstOutput.sink,
      { signal: controller.signal, timeout: 60_000 }
    );
    const blockedOutcome = blocked.then(
      () => null,
      (error: unknown) => error
    );

    await ready;
    const abortStarted = Date.now();
    controller.abort(new Error("client disconnected"));
    const blockedError = await Promise.race([
      blockedOutcome,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("sandbox abort did not settle")), 2_000)
      ),
    ]);
    expect(blockedError).toBeInstanceOf(Error);
    expect((blockedError as Error).message).toContain("client disconnected");
    expect(Date.now() - abortStarted).toBeLessThan(2_000);
    expect(firstOutput.stdout.join("")).not.toContain("late");

    const nextOutput = createOutput();
    await runScript(
      `
        const page = await browser.getPage("abort-reuse");
        await page.locator("#ok").click({ timeout: 5000 });
        console.log(await page.locator("#ok").textContent());
      `,
      manager,
      "default",
      nextOutput.sink,
      { timeout: 10_000 }
    );
    expect(nextOutput.stdout.join("")).toContain("Ready");
  }, 30_000);

  it("routes console output to stdout", async () => {
    const output = createOutput();

    await runScript(
      `
        console.log("sandbox", 42, { ok: true });
      `,
      manager,
      "default",
      output.sink
    );

    expect(output.stdout.join("")).toContain("sandbox 42 { ok: true }");
    expect(output.stderr.join("")).toBe("");
  });

  it("supports Buffer.isBuffer", async () => {
    const output = createOutput();

    await runScript(
      `
        console.log(
          Buffer.isBuffer(Buffer.from([1, 2, 3])),
          Buffer.isBuffer(new Uint8Array(3)),
          Buffer.isBuffer("nope")
        );
      `,
      manager,
      "default",
      output.sink
    );

    expect(output.stdout.join("")).toContain("true false false");
    expect(output.stderr.join("")).toBe("");
  });
});
