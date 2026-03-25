import {
  mkdtemp,
  readFile as readFileFs,
  rm,
  stat,
  symlink,
  writeFile as writeFileFs,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "../../browser-manager.js";
import {
  DEV_BROWSER_TMP_DIR,
  ensureDevBrowserTempDir,
  resolveDevBrowserTempPath,
} from "../../temp-files.js";
import { runScript } from "../script-runner-quickjs.js";
import { ensureSandboxClientBundle } from "./bundle-test-helpers.js";

const browserName = "sandbox-file-io";
const INVALID_PATH_ERROR =
  /absolute paths are not allowed|null bytes|must not contain|escapes the controlled temp directory|symlink/i;

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

function parseLastJsonLine<T>(output: CapturedOutput): T {
  const lines = output.stdout.map((line) => line.trim()).filter((line) => line.length > 0);
  const lastLine = lines.at(-1);
  if (!lastLine) {
    throw new Error("Expected sandbox output");
  }

  return JSON.parse(lastLine) as T;
}

describe.sequential("QuickJS sandbox file I/O", () => {
  let browserRootDir = "";
  let manager: BrowserManager;
  const cleanupPaths = new Set<string>();

  beforeAll(async () => {
    await ensureSandboxClientBundle();

    await ensureDevBrowserTempDir();

    browserRootDir = await mkdtemp(path.join(os.tmpdir(), "dev-browser-quickjs-file-io-"));
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
    await manager.ensureBrowser(browserName, {
      headless: true,
    });
  }, 180_000);

  afterEach(async () => {
    for (const filePath of cleanupPaths) {
      await rm(filePath, {
        recursive: true,
        force: true,
      });
    }
    cleanupPaths.clear();
  });

  afterAll(async () => {
    await manager.stopAll();
    await rm(browserRootDir, {
      recursive: true,
      force: true,
    });
  }, 180_000);

  async function runSandboxScript(script: string): Promise<CapturedOutput> {
    const output = createOutput();
    await runScript(script, manager, browserName, output.sink, {
      timeout: 60_000,
    });
    return output;
  }

  async function expectSandboxScriptToThrow(
    script: string,
    matcher = INVALID_PATH_ERROR
  ): Promise<void> {
    const output = createOutput();
    await expect(
      runScript(script, manager, browserName, output.sink, { timeout: 60_000 })
    ).rejects.toThrow(matcher);
  }

  it("saves screenshot buffers into the controlled temp directory", async () => {
    const requestedName = "sandbox file io screenshot?.png";
    const expectedPath = await resolveDevBrowserTempPath(requestedName);
    cleanupPaths.add(expectedPath);

    const output = await runSandboxScript(`
      const page = await browser.getPage("file-io-save-screenshot");
      await page.setContent("<html><body><h1>Screenshot</h1></body></html>");
      const screenshot = await page.screenshot();
      const savedPath = await saveScreenshot(screenshot, ${JSON.stringify(requestedName)});
      console.log(JSON.stringify({ savedPath, size: screenshot.length }));
    `);

    const result = parseLastJsonLine<{ savedPath: string; size: number }>(output);
    expect(result.savedPath).toBe(expectedPath);
    expect(result.savedPath.startsWith(`${path.resolve(DEV_BROWSER_TMP_DIR)}${path.sep}`)).toBe(
      true
    );
    expect(result.size).toBeGreaterThan(0);
    expect((await stat(result.savedPath)).size).toBeGreaterThan(0);
  }, 120_000);

  it("writes page.screenshot({ path }) into the controlled temp directory", async () => {
    const requestedName = "page screenshot path?.png";
    const expectedPath = await resolveDevBrowserTempPath(requestedName);
    cleanupPaths.add(expectedPath);

    const output = await runSandboxScript(`
      const page = await browser.getPage("file-io-page-screenshot");
      await page.setContent("<html><body><h1>Path Screenshot</h1></body></html>");
      const options = { path: ${JSON.stringify(requestedName)} };
      const screenshot = await page.screenshot(options);
      console.log(JSON.stringify({ savedPath: options.path, size: screenshot.length }));
    `);

    const result = parseLastJsonLine<{ savedPath: string; size: number }>(output);
    expect(result.savedPath).toBe(expectedPath);
    expect(result.size).toBeGreaterThan(0);
    expect((await stat(result.savedPath)).size).toBeGreaterThan(0);
  }, 120_000);

  it("writes and reads back controlled temp files", async () => {
    const requestedName = "sandbox file io data?.json";
    const expectedPath = await resolveDevBrowserTempPath(requestedName);
    cleanupPaths.add(expectedPath);

    const output = await runSandboxScript(`
      const savedPath = await writeFile(
        ${JSON.stringify(requestedName)},
        JSON.stringify({ ok: true, value: 42 }),
      );
      const content = await readFile(${JSON.stringify(requestedName)});
      console.log(JSON.stringify({ savedPath, content }));
    `);

    const result = parseLastJsonLine<{ savedPath: string; content: string }>(output);
    expect(result.savedPath).toBe(expectedPath);
    expect(result.content).toBe('{"ok":true,"value":42}');
    expect(await readFileFs(result.savedPath, "utf8")).toBe(result.content);
  });

  it("sanitizes harmless filename characters before writing", async () => {
    const requestedName = "report 2026:03:18?.json";
    const expectedPath = await resolveDevBrowserTempPath(requestedName);
    cleanupPaths.add(expectedPath);

    const output = await runSandboxScript(`
      const savedPath = await writeFile(${JSON.stringify(requestedName)}, "sanitized");
      console.log(JSON.stringify({ savedPath }));
    `);

    const result = parseLastJsonLine<{ savedPath: string }>(output);
    expect(result.savedPath).toBe(expectedPath);
    expect(path.basename(result.savedPath)).toBe("report_2026_03_18_.json");
    expect(await readFileFs(result.savedPath, "utf8")).toBe("sanitized");
  });

  it("rejects traversal, absolute paths, and null bytes", async () => {
    const invalidNames = [
      "../escape",
      "..\\escape",
      "../../etc/passwd",
      "safe/../../escape",
      "/absolute/path",
      "C:\\evil.txt",
      "bad\0name.txt",
    ];

    const output = await runSandboxScript(`
      const invalidNames = ${JSON.stringify(invalidNames)};
      const results = [];
      const operations = [
        ["writeFile", async (name) => await writeFile(name, "blocked")],
        ["readFile", async (name) => await readFile(name)],
        [
          "saveScreenshot",
          async (name) => await saveScreenshot(new Uint8Array([1, 2, 3]), name),
        ],
      ];

      for (const invalidName of invalidNames) {
        for (const [label, operation] of operations) {
          try {
            await operation(invalidName);
            results.push({ invalidName, label, ok: true, message: null });
          } catch (error) {
            results.push({
              invalidName,
              label,
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      console.log(JSON.stringify(results));
    `);

    const results = parseLastJsonLine<
      Array<{
        invalidName: string;
        label: string;
        ok: boolean;
        message: string | null;
      }>
    >(output);

    expect(results).toHaveLength(invalidNames.length * 3);

    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.message ?? "").toMatch(INVALID_PATH_ERROR);
    }
  });

  it("rejects unsafe screenshot path options", async () => {
    await expectSandboxScriptToThrow(`
      const page = await browser.getPage("file-io-invalid-screenshot");
      await page.setContent("<html><body><h1>Invalid</h1></body></html>");
      await page.screenshot({ path: "../escape.png" });
    `);
  }, 120_000);

  it("rejects symlinked temp-file targets", async () => {
    const symlinkName = "sandbox-file-io-symlink.txt";
    const symlinkPath = path.join(DEV_BROWSER_TMP_DIR, symlinkName);
    const targetPath = path.join(os.tmpdir(), "sandbox-file-io-symlink-target.txt");

    cleanupPaths.add(symlinkPath);
    cleanupPaths.add(targetPath);

    await writeFileFs(targetPath, "outside", "utf8");
    await symlink(targetPath, symlinkPath);

    await expectSandboxScriptToThrow(
      `await writeFile(${JSON.stringify(symlinkName)}, "should fail");`
    );
    await expectSandboxScriptToThrow(`await readFile(${JSON.stringify(symlinkName)});`);
  });
});
