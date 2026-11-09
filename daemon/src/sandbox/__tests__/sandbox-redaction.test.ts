import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "../../browser-manager.js";
import { ensureDevBrowserTempDir, resolveDevBrowserTempPath } from "../../temp-files.js";
import { removeDirectoryWithRetries } from "../../test-cleanup.js";
import { runScript } from "../script-runner-quickjs.js";
import { ensureSandboxClientBundle } from "./bundle-test-helpers.js";

const browserName = "sandbox-redaction";
const typedValue = 'Gate "Value" 123';
const registerLine = `await secrets.register("GATE_VALUE", ${JSON.stringify(typedValue)});`;

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
  sink: {
    onStdout: (data: string) => void;
    onStderr: (data: string) => void;
  };
}

function createOutput(): CapturedOutput {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    sink: {
      onStdout: (data) => stdout.push(data),
      onStderr: (data) => stderr.push(data),
    },
  };
}

describe.sequential("QuickJS sandbox redaction", () => {
  let browserRootDir = "";
  let manager: BrowserManager;
  const cleanupPaths = new Set<string>();

  beforeAll(async () => {
    await ensureSandboxClientBundle();
    await ensureDevBrowserTempDir();

    browserRootDir = await mkdtemp(path.join(os.tmpdir(), "dev-browser-quickjs-redaction-"));
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
    await manager.ensureBrowser(browserName, { headless: true });
  }, 180_000);

  afterEach(async () => {
    for (const filePath of cleanupPaths) {
      await rm(filePath, { force: true });
    }
    cleanupPaths.clear();
  });

  afterAll(async () => {
    await manager.stopAll();
    await removeDirectoryWithRetries(browserRootDir);
  }, 180_000);

  async function runSandboxScript(script: string): Promise<CapturedOutput> {
    const output = createOutput();
    await runScript(script, manager, browserName, output.sink, { timeout: 60_000 });
    return output;
  }

  it("redacts registered values in stdout and stderr", async () => {
    const output = await runSandboxScript(`
      ${registerLine}
      console.log("typed", ${JSON.stringify(typedValue)});
      console.log({ field: ${JSON.stringify(typedValue)} });
      console.error("failed with " + ${JSON.stringify(typedValue)});
    `);

    const all = [...output.stdout, ...output.stderr].join("");
    expect(all).not.toContain(typedValue);
    expect(all).not.toContain(JSON.stringify(typedValue).slice(1, -1));
    expect(output.stdout.join("")).toContain("typed [REDACTED:GATE_VALUE]");
    expect(output.stderr.join("")).toContain("failed with [REDACTED:GATE_VALUE]");
  }, 120_000);

  it("leaves output unchanged when nothing is registered", async () => {
    const output = await runSandboxScript(`
      console.log("typed", ${JSON.stringify(typedValue)});
    `);

    expect(output.stdout.join("")).toContain(typedValue);
  }, 120_000);

  it("redacts text written through writeFile", async () => {
    const fileName = "sandbox-redaction-summary.json";
    cleanupPaths.add(await resolveDevBrowserTempPath(fileName));

    await runSandboxScript(`
      ${registerLine}
      await writeFile(${JSON.stringify(fileName)}, JSON.stringify({ typed: ${JSON.stringify(typedValue)} }));
    `);

    const written = await readFile(await resolveDevBrowserTempPath(fileName), "utf8");
    expect(written).toBe('{"typed":"[REDACTED:GATE_VALUE]"}');
  }, 120_000);

  it("redacts thrown script errors and keeps the error name", async () => {
    const output = createOutput();
    const run = runScript(
      `
        ${registerLine}
        throw new RangeError("cannot use " + ${JSON.stringify(typedValue)});
      `,
      manager,
      browserName,
      output.sink,
      { timeout: 60_000 }
    );

    const error = await run.then(
      () => undefined,
      (failure: unknown) => failure
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("cannot use [REDACTED:GATE_VALUE]");
    expect((error as Error).message).not.toContain(typedValue);
    expect((error as Error).stack ?? "").not.toContain(typedValue);
  }, 120_000);

  it("rejects an invalid registration", async () => {
    const output = createOutput();
    await expect(
      runScript(
        `await secrets.register("not valid", "value");`,
        manager,
        browserName,
        output.sink,
        { timeout: 60_000 }
      )
    ).rejects.toThrow(/name must match/);
  }, 120_000);

  it("writes recorded fills of a registered value as env references", async () => {
    const outputFile = "sandbox-redaction-login.spec.ts";
    cleanupPaths.add(await resolveDevBrowserTempPath(outputFile));

    await runSandboxScript(`
      ${registerLine}
      const page = await browser.getPage("redaction-recording");
      await page.setContent('<label for="gate">Heslo</label><input id="gate" type="password">');
      recording.start({ testName: "Gate login", outputFile: ${JSON.stringify(outputFile)} });
      const rPage = recording.wrap(page);
      await rPage.getByLabel("Heslo").fill(${JSON.stringify(typedValue)});
      await recording.checkpoint("Gate filled", rPage);
      await recording.stop();
    `);

    const spec = await readFile(await resolveDevBrowserTempPath(outputFile), "utf8");
    expect(spec).toContain('getByLabel("Heslo").fill(process.env.GATE_VALUE!)');
    expect(spec).not.toContain(typedValue);
  }, 120_000);
});
