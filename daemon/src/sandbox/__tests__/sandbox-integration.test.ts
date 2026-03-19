import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "../../browser-manager.js";
import { runScript } from "../script-runner-quickjs.js";

const execFileAsync = promisify(execFile);
const daemonDir = new URL("../../../", import.meta.url);
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

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
    await execFileAsync(pnpmCommand, ["run", "bundle:sandbox-client"], {
      cwd: daemonDir,
    });

    browserRootDir = await mkdtemp(path.join(os.tmpdir(), "dev-browser-quickjs-"));
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
    await manager.ensureBrowser("default", {
      headless: true,
    });
  }, 180_000);

  afterAll(async () => {
    await manager.stopAll();
    await rm(browserRootDir, {
      recursive: true,
      force: true,
    });
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
      },
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
      },
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
      },
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
        output.sink,
      ),
    ).rejects.toThrow("boom");
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
        },
      ),
    ).rejects.toThrow(/timed out|interrupted/i);
  }, 120_000);

  it("routes console output to stdout", async () => {
    const output = createOutput();

    await runScript(
      `
        console.log("sandbox", 42, { ok: true });
      `,
      manager,
      "default",
      output.sink,
    );

    expect(output.stdout.join("")).toContain("sandbox 42 { ok: true }");
    expect(output.stderr.join("")).toBe("");
  });
});
