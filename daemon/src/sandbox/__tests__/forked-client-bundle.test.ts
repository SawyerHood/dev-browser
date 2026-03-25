import { readFile } from "node:fs/promises";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { QuickJSHost } from "../quickjs-host.js";
import { ensureSandboxClientBundle } from "./bundle-test-helpers.js";

const bundleUrl = new URL("../../../dist/sandbox-client.js", import.meta.url);

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
  await ensureSandboxClientBundle();
  bundleCode = await readFile(bundleUrl, "utf8");
}, 120_000);

describe("forked Playwright bundle", () => {
  it("loads into QuickJS and exposes the client entry points", async () => {
    const host = await createHost();

    expect(() =>
      host.executeScriptSync(bundleCode, {
        filename: "sandbox-client.js",
      })
    ).not.toThrow();

    expect(host.executeScriptSync("typeof __PlaywrightClient.Connection")).toBe("function");
    expect(host.executeScriptSync("typeof __PlaywrightClient.quickjsPlatform")).toBe("object");

    expect(() =>
      host.executeScriptSync(`
        globalThis.__sandboxConnection = new __PlaywrightClient.Connection();
      `)
    ).not.toThrow();

    expect(host.executeScriptSync("typeof __sandboxConnection.dispatch")).toBe("function");
  }, 120_000);
});
