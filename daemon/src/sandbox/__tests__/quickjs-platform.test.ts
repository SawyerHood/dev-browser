import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "../../browser-manager.js";
import { removeDirectoryWithRetries } from "../../test-cleanup.js";
import { quickjsPlatform } from "../forked-client/quickjs-platform.js";
import { QuickJSSandbox } from "../quickjs-sandbox.js";
import { ensureSandboxClientBundle } from "./bundle-test-helpers.js";

const SANDBOX_TIMEOUT_MS = 60_000;

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
}

interface JsonSandboxHarness {
  dispose: () => Promise<void>;
  runJson: <T>(script: string) => Promise<T>;
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

function clearOutput(output: CapturedOutput): void {
  output.stdout.length = 0;
  output.stderr.length = 0;
}

function parseLastJsonLine<T>(output: CapturedOutput): T {
  const lines = output.stdout.map((line) => line.trim()).filter((line) => line.length > 0);
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines.at(-1)!) as T;
}

async function createSandboxHarness(
  manager: BrowserManager,
  browserName: string
): Promise<JsonSandboxHarness> {
  await manager.ensureBrowser(browserName, {
    headless: true,
  });

  const output = createOutput();
  const sandbox = new QuickJSSandbox({
    manager,
    browserName,
    onStdout: output.sink.onStdout,
    onStderr: output.sink.onStderr,
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });

  await sandbox.initialize();

  return {
    dispose: async () => {
      await sandbox.dispose();
    },
    runJson: async <T>(script: string): Promise<T> => {
      clearOutput(output);
      await sandbox.executeScript(`(async () => {\n${script}\n})()`);
      expect(output.stderr).toEqual([]);
      return parseLastJsonLine<T>(output);
    },
  };
}

describe("quickjsPlatform fs/path unsupported-API messages (P2-3)", () => {
  // Unit level: pin the exact authored text the stubs throw. Playwright's
  // internal fs()/path() modules back setInputFiles({path}),
  // addInitScript({path}), page.pdf({path}), context.storageState({path}),
  // etc. None of them work in the QuickJS sandbox (no real filesystem), so
  // the message must name the limitation and the workaround instead of the
  // bare "fs is not available in the QuickJS sandbox" it used to be.
  it("names the upload workaround when fs() is called", () => {
    expect(() => quickjsPlatform.fs()).toThrow(
      "fs is not available in the QuickJS sandbox"
    );
    let message = "";
    try {
      quickjsPlatform.fs();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("setInputFiles({ name, mimeType, buffer })");
    expect(message).toContain("readFile()");
    expect(message).toContain("addInitScript({ path })");
  });

  it("gives path() the same no-filesystem explanation", () => {
    let message = "";
    try {
      quickjsPlatform.path();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("path is not available in the QuickJS sandbox");
    expect(message).toContain("addInitScript({ content })");
  });

  it("leaves the other unsupported stubs on their generic message", () => {
    expect(() => quickjsPlatform.streamFile("unused", {} as never)).toThrow(
      "streamFile is not available in the QuickJS sandbox"
    );
  });

  describe.sequential("end-to-end through the sandboxed Playwright client", () => {
    const browserName = "quickjs-platform-fs";
    let browserRootDir = "";
    let manager: BrowserManager;
    let harness: JsonSandboxHarness;

    beforeAll(async () => {
      await ensureSandboxClientBundle();

      browserRootDir = await mkdtemp(path.join(os.tmpdir(), "dev-browser-quickjs-platform-"));
      manager = new BrowserManager(path.join(browserRootDir, "browsers"));
      harness = await createSandboxHarness(manager, browserName);
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await manager.stopAll();
      await removeDirectoryWithRetries(browserRootDir);
    }, 180_000);

    it("surfaces the authored fs message when setInputFiles is given a path string", async () => {
      const result = await harness.runJson<{ error: string | null }>(`
        const page = await browser.getPage("quickjs-platform-upload");
        await page.setContent('<input id="file" type="file" />', { waitUntil: "load" });
        let error = null;
        try {
          await page.setInputFiles("#file", "some/local/path.txt");
        } catch (caught) {
          error = String((caught && caught.message) || caught);
        }
        console.log(JSON.stringify({ error }));
      `);

      expect(result.error).toContain("fs is not available in the QuickJS sandbox");
      expect(result.error).toContain("setInputFiles({ name, mimeType, buffer })");
    }, 30_000);

    it("surfaces the same authored message for addInitScript({ path })", async () => {
      const result = await harness.runJson<{ error: string | null }>(`
        const page = await browser.getPage("quickjs-platform-init-script");
        let error = null;
        try {
          await page.addInitScript({ path: "some/local/init.js" });
        } catch (caught) {
          error = String((caught && caught.message) || caught);
        }
        console.log(JSON.stringify({ error }));
      `);

      expect(result.error).toContain("fs is not available in the QuickJS sandbox");
      expect(result.error).toContain("addInitScript({ content })");
    }, 30_000);
  });
});
