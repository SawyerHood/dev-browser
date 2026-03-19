import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { BrowserManager } from "../../browser-manager.js";
import { runScript } from "../script-runner-quickjs.js";

const browserName = "sandbox-security";

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

describe.sequential("QuickJS sandbox security", () => {
  let browserRootDir = "";
  let manager: BrowserManager;

  beforeAll(async () => {
    browserRootDir = await mkdtemp(path.join(os.tmpdir(), "dev-browser-quickjs-security-"));
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
    await manager.ensureBrowser(browserName, {
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

  async function runSandboxScript(
    script: string,
    options: { timeout?: number; memoryLimitBytes?: number } = {}
  ): Promise<CapturedOutput> {
    const output = createOutput();
    await runScript(script, manager, browserName, output.sink, options);
    return output;
  }

  function expectSandboxScriptToThrow(
    script: string,
    matcher: RegExp,
    options: { timeout?: number; memoryLimitBytes?: number } = {}
  ): Promise<void> {
    const output = createOutput();
    return expect(runScript(script, manager, browserName, output.sink, options)).rejects.toThrow(
      matcher
    );
  }

  it("does not expose require", async () => {
    await expectSandboxScriptToThrow(`require("fs");`, /require|not defined/i);
  });

  it("does not expose process", async () => {
    await expectSandboxScriptToThrow(`process.exit();`, /process|not defined/i);
  });

  it("does not expose fetch", async () => {
    await expectSandboxScriptToThrow(`fetch("https://evil.com");`, /fetch|not defined/i);
  });

  it("does not expose WebSocket", async () => {
    await expectSandboxScriptToThrow(
      `new WebSocket("wss://evil.example");`,
      /WebSocket|not defined/i
    );
  });

  it("does not escape through the constructor chain", async () => {
    await expectSandboxScriptToThrow(
      `this.constructor.constructor("return process")();`,
      /process|not defined/i
    );
  });

  it("does not allow dynamic imports", async () => {
    await expectSandboxScriptToThrow(`await import("node:fs");`, /import|module|load/i);
  });

  it("enforces memory limits", async () => {
    await expectSandboxScriptToThrow(
      `
        const chunks = [];
        while (true) {
          chunks.push("x".repeat(1024));
        }
      `,
      /out of memory/i,
      {
        memoryLimitBytes: 1024 * 1024,
      }
    );
  }, 120_000);

  it("enforces CPU time limits", async () => {
    await expectSandboxScriptToThrow(`while (true) {}`, /timed out|interrupted/i, {
      timeout: 25,
    });
  }, 120_000);

  it("only exposes the expected globals and browser API", async () => {
    const output = await runSandboxScript(`
      console.log(
        JSON.stringify({
          globals: Object.getOwnPropertyNames(globalThis).sort(),
          browserKeys: Object.getOwnPropertyNames(browser).sort(),
          browserHasNullPrototype: Object.getPrototypeOf(browser) === null,
        }),
      );
    `);

    expect(output.stderr).toEqual([]);
    expect(output.stdout).toHaveLength(1);

    const reportLine = output.stdout[0];
    if (reportLine === undefined) {
      throw new Error("Sandbox globals report was not captured");
    }

    const payload = JSON.parse(reportLine) as {
      globals: string[];
      browserKeys: string[];
      browserHasNullPrototype: boolean;
    };

    expect(payload.globals).not.toContain("require");
    expect(payload.globals).not.toContain("process");
    expect(payload.globals).not.toContain("fetch");
    expect(payload.globals).not.toContain("__dirname");
    expect(payload.globals).not.toContain("__filename");
    expect(payload.globals).not.toContain("__hostCall");
    expect(payload.globals).not.toContain("__transport_send");
    expect(payload.globals).not.toContain("__connection");
    expect(payload.globals).not.toContain("__playwright");
    expect(payload.globals).not.toContain("__browser");
    expect(payload.globals).not.toContain("__PlaywrightClient");
    expect(payload.globals).not.toContain("__createPlaywrightClient");
    expect(payload.globals).toContain("readFile");
    expect(payload.globals).toContain("saveScreenshot");
    expect(payload.globals).toContain("writeFile");
    expect(payload.browserKeys).toEqual(["closePage", "getPage", "listPages", "newPage"]);
    expect(payload.browserHasNullPrototype).toBe(true);
  }, 120_000);

  it("captures console output without leaking to host stdout", async () => {
    const output = createOutput();
    const stdoutSpy = vi.spyOn(process.stdout, "write");
    let leakedToHostStdout = false;

    try {
      await runScript(`console.log("secret");`, manager, browserName, output.sink);
      leakedToHostStdout = stdoutSpy.mock.calls.some((args) =>
        args.some((value) => String(value).includes("secret"))
      );
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(output.stdout.join("")).toContain("secret");
    expect(output.stderr).toEqual([]);
    expect(leakedToHostStdout).toBe(false);
  });
});
