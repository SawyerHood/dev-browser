import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "../../browser-manager.js";
import { removeDirectoryWithRetries } from "../../test-cleanup.js";
import { runScript } from "../script-runner-quickjs.js";
import { ensureSandboxClientBundle } from "./bundle-test-helpers.js";

// P2-1: the sandbox's setInputFiles is unusable for real uploads — there is
// no filesystem for the { path } form, and the { buffer } form still has to
// round-trip through the sandbox's protocol bridge (see
// quickjs-platform.ts's fs() stub and ObsidianVault/References/dev-browser-taxonomy's
// file-upload-pdf-handling cluster). uploadFile() sidesteps all of that by
// running page.setInputFiles() on the DAEMON side, against the real
// Playwright `Page` the browser manager holds — these tests assert the file
// actually lands in the page's <input type="file">, not just that the call
// doesn't throw.

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

describe.sequential("QuickJS sandbox uploadFile() (P2-1)", () => {
  let browserRootDir = "";
  let manager: BrowserManager;
  const browserName = "sandbox-upload-file";

  beforeAll(async () => {
    await ensureSandboxClientBundle();

    browserRootDir = await mkdtemp(path.join(os.tmpdir(), "dev-browser-quickjs-upload-"));
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
    await manager.ensureBrowser(browserName, {
      headless: true,
    });
  }, 180_000);

  afterAll(async () => {
    await manager.stopAll();
    await removeDirectoryWithRetries(browserRootDir);
  }, 180_000);

  async function runSandboxScript(script: string): Promise<CapturedOutput> {
    const output = createOutput();
    await runScript(script, manager, browserName, output.sink, {
      timeout: 60_000,
    });
    return output;
  }

  it("lands a base64-encoded file on a real <input type=file>", async () => {
    const fileContents = "hello upload";
    const base64 = Buffer.from(fileContents, "utf8").toString("base64");

    const output = await runSandboxScript(`
      const page = await browser.getPage("upload-base64");
      await page.setContent('<input id="file" type="file" />');

      await uploadFile("upload-base64", "#file", {
        name: "hello.txt",
        mimeType: "text/plain",
        base64: ${JSON.stringify(base64)},
      });

      const result = await page.evaluate(() => {
        const input = document.querySelector("#file");
        const file = input.files[0];
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              name: file.name,
              type: file.type,
              size: file.size,
              text: reader.result,
            });
          reader.onerror = () => reject(reader.error);
          reader.readAsText(file);
        });
      });

      console.log(JSON.stringify(result));
    `);

    const result = parseLastJsonLine<{
      name: string;
      type: string;
      size: number;
      text: string;
    }>(output);

    expect(result.name).toBe("hello.txt");
    expect(result.type).toBe("text/plain");
    expect(result.text).toBe(fileContents);
    expect(result.size).toBe(Buffer.byteLength(fileContents, "utf8"));
  }, 120_000);

  it("lands a buffer-form file (encoded to base64 inside the sandbox)", async () => {
    const fileBytes = [104, 101, 108, 108, 111]; // "hello"

    const output = await runSandboxScript(`
      const page = await browser.getPage("upload-buffer");
      await page.setContent('<input id="file" type="file" />');

      await uploadFile("upload-buffer", "#file", {
        name: "buffer-upload.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from(${JSON.stringify(fileBytes)}),
      });

      const result = await page.evaluate(() => {
        const input = document.querySelector("#file");
        const file = input.files[0];
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              name: file.name,
              type: file.type,
              bytes: Array.from(new Uint8Array(reader.result)),
            });
          reader.onerror = () => reject(reader.error);
          reader.readAsArrayBuffer(file);
        });
      });

      console.log(JSON.stringify(result));
    `);

    const result = parseLastJsonLine<{
      name: string;
      type: string;
      bytes: number[];
    }>(output);

    expect(result.name).toBe("buffer-upload.bin");
    expect(result.type).toBe("application/octet-stream");
    expect(result.bytes).toEqual(fileBytes);
  }, 120_000);

  it("rejects a malformed file argument before making a host call", async () => {
    const output = createOutput();

    await expect(
      runScript(
        `
          const page = await browser.getPage("upload-invalid");
          await page.setContent('<input id="file" type="file" />');
          await uploadFile("upload-invalid", "#file", { name: "no-data.txt" });
        `,
        manager,
        browserName,
        output.sink,
        { timeout: 30_000 }
      )
    ).rejects.toThrow(/base64|buffer/i);
  }, 60_000);
});
