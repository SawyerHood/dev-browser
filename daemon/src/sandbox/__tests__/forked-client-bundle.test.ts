import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { QuickJSHost } from "../quickjs-host.js";

const execFileAsync = promisify(execFile);
const daemonDir = new URL("../../../", import.meta.url);
const bundleUrl = new URL("../../../dist/sandbox-client.js", import.meta.url);
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const hosts = new Set<QuickJSHost>();

let bundleCode = "";

async function createHost(): Promise<QuickJSHost> {
  const host = await QuickJSHost.create();
  hosts.add(host);
  return host;
}

afterEach(() => {
  for (const host of hosts) {
    host.dispose();
  }
  hosts.clear();
});

beforeAll(async () => {
  await execFileAsync(pnpmCommand, ["run", "bundle:sandbox-client"], {
    cwd: daemonDir,
  });
  bundleCode = await readFile(bundleUrl, "utf8");
}, 120_000);

describe("forked Playwright bundle", () => {
  it("loads into QuickJS and exposes the client entry points", async () => {
    const host = await createHost();

    expect(() =>
      host.executeScriptSync(bundleCode, {
        filename: "sandbox-client.js",
      }),
    ).not.toThrow();

    expect(host.executeScriptSync("typeof __PlaywrightClient.Connection")).toBe("function");
    expect(host.executeScriptSync("typeof __PlaywrightClient.quickjsPlatform")).toBe("object");

    expect(() =>
      host.executeScriptSync(`
        globalThis.__sandboxConnection = new __PlaywrightClient.Connection();
      `),
    ).not.toThrow();

    expect(host.executeScriptSync("typeof __sandboxConnection.dispatch")).toBe("function");
  }, 120_000);
});
