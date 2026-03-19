import { afterEach, describe, expect, it } from "vitest";

import { QuickJSHost } from "../quickjs-host.js";

const hosts = new Set<QuickJSHost>();

async function createHost(
  options: Parameters<typeof QuickJSHost.create>[0] = {},
): Promise<QuickJSHost> {
  const host = await QuickJSHost.create(options);
  hosts.add(host);
  return host;
}

afterEach(() => {
  for (const host of hosts) {
    host.dispose();
  }
  hosts.clear();
});

describe("QuickJSHost", () => {
  it("executes simple expressions", async () => {
    const host = await createHost({
      globals: {
        appName: "dev-browser",
      },
    });

    expect(host.executeScriptSync("1 + 2 + 3")).toBe(6);
    expect(host.executeScriptSync("appName")).toBe("dev-browser");
  });

  it("exposes host functions and transport callbacks", async () => {
    const sentMessages: string[] = [];
    const host = await createHost({
      hostFunctions: {
        add: (left: unknown, right: unknown) => Number(left) + Number(right),
      },
      onTransportSend: (message) => {
        sentMessages.push(message);
      },
    });

    expect(host.executeScriptSync('__hostCall("add", JSON.stringify([4, 5]))')).toBe(9);
    expect(
      host.executeScriptSync('__transport_send(JSON.stringify({ type: "ping", id: 1 }))'),
    ).toBeUndefined();
    expect(sentMessages).toEqual(['{"type":"ping","id":1}']);
  });

  it("handles async host functions", async () => {
    const host = await createHost({
      hostFunctions: {
        addAsync: async (left: unknown, right: unknown) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return Number(left) + Number(right);
        },
      },
    });

    await expect(
      host.executeScript(`
        (async () => {
          return await __hostCall("addAsync", JSON.stringify([7, 8]));
        })()
      `),
    ).resolves.toBe(15);
  });

  it("lets the host call functions inside the sandbox", async () => {
    const host = await createHost();

    host.executeScriptSync(`
      globalThis.__transport_receive = (message) => {
        globalThis.lastMessage = message;
        return message.toUpperCase();
      };
    `);

    await expect(host.callFunction("__transport_receive", "hello from host")).resolves.toBe(
      "HELLO FROM HOST",
    );
    expect(host.executeScriptSync("lastMessage")).toBe("hello from host");
  });

  it("supports setTimeout and clearTimeout", async () => {
    const host = await createHost();

    await expect(
      host.executeScript(`
        (async () => {
          let fired = false;
          const cancelled = setTimeout(() => {
            fired = true;
          }, 1);
          clearTimeout(cancelled);

          return await new Promise((resolve) => {
            setTimeout(() => resolve(fired ? "wrong" : "done"), 5);
          });
        })()
      `),
    ).resolves.toBe("done");
  });

  it("enforces memory limits", async () => {
    const host = await createHost({
      memoryLimitBytes: 1024 * 1024,
    });

    await expect(
      host.executeScript(`
        const chunks = [];
        while (true) {
          chunks.push("x".repeat(1024));
        }
      `),
    ).rejects.toThrow(/out of memory/i);
  });

  it("enforces CPU time limits", async () => {
    const host = await createHost({
      cpuTimeoutMs: 10,
    });

    await expect(host.executeScript("while (true) {}")).rejects.toThrow(/interrupted/i);
  });

  it("routes console output to the host callback", async () => {
    const entries: Array<{ level: string; args: unknown[] }> = [];
    const host = await createHost({
      onConsole: (level, args) => {
        entries.push({ level, args });
      },
    });

    expect(host.executeScriptSync('console.log("hello", 42, { ok: true })')).toBeUndefined();
    expect(entries).toEqual([
      {
        level: "log",
        args: ["hello", 42, { ok: true }],
      },
    ]);
  });

  it("disposes resources cleanly", async () => {
    const host = await createHost();

    host.executeScriptSync("setTimeout(() => {}, 1)");

    expect(() => host.dispose()).not.toThrow();
    expect(host.disposed).toBe(true);
    expect(() => host.dispose()).not.toThrow();
    await expect(host.executeScript("1 + 1")).rejects.toThrow(/disposed/i);

    hosts.delete(host);
  });
});
