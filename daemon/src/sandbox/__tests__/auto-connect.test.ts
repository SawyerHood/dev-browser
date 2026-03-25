import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserManager } from "../../browser-manager.js";
import { parseRequest } from "../../protocol.js";

class MockCDPSession {
  private readonly targetId: string;

  constructor(targetId: string) {
    this.targetId = targetId;
  }

  async send(method: string): Promise<{ targetInfo: { targetId: string } }> {
    expect(method).toBe("Target.getTargetInfo");
    return {
      targetInfo: {
        targetId: this.targetId,
      },
    };
  }

  async detach(): Promise<void> {}
}

class MockPage extends EventEmitter {
  private closed = false;
  readonly targetId: string;
  readonly pageTitle: string;
  readonly pageUrl: string;

  constructor(options: { targetId?: string; title?: string; url?: string } = {}) {
    super();
    this.targetId = options.targetId ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    this.pageTitle = options.title ?? "";
    this.pageUrl = options.url ?? "about:blank";
  }

  isClosed(): boolean {
    return this.closed;
  }

  url(): string {
    return this.pageUrl;
  }

  async title(): Promise<string> {
    return this.pageTitle;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.emit("close");
  }
}

class MockContext {
  readonly pagesList: MockPage[];
  newPageCalls = 0;
  closeCalls = 0;

  constructor(pages: MockPage[] = []) {
    this.pagesList = pages;
  }

  pages(): MockPage[] {
    return this.pagesList;
  }

  async newCDPSession(page: MockPage): Promise<MockCDPSession> {
    return new MockCDPSession(page.targetId);
  }

  async newPage(): Promise<MockPage> {
    this.newPageCalls += 1;
    const page = new MockPage({
      targetId: `${this.newPageCalls}`.padStart(32, "0"),
    });
    this.pagesList.push(page);
    return page;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class MockBrowser extends EventEmitter {
  readonly contextsList: MockContext[];
  closeCalls = 0;
  newContextCalls = 0;
  private connected = true;

  constructor(contexts: MockContext[] = []) {
    super();
    this.contextsList = contexts;
  }

  contexts(): MockContext[] {
    return this.contextsList;
  }

  async newContext(): Promise<MockContext> {
    this.newContextCalls += 1;
    const context = new MockContext();
    this.contextsList.push(context);
    return context;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.connected = false;
    this.emit("disconnected");
  }

  disconnect(): void {
    this.connected = false;
    this.emit("disconnected");
  }
}

type BrowserManagerInternals = {
  readDevToolsActivePort(expectedPort?: number): Promise<string | null>;
  discoverChrome(): Promise<string | null>;
  probePort(port: number): Promise<string | null>;
};

function createEnoentError(filePath: string): NodeJS.ErrnoException {
  const error = new Error(
    `ENOENT: no such file or directory, open '${filePath}'`
  ) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

function createManager(
  options: {
    connectOverCDP?: ReturnType<typeof vi.fn>;
    fetch?: typeof globalThis.fetch;
    homedir?: () => string;
    platform?: NodeJS.Platform;
    readFile?: ReturnType<typeof vi.fn>;
  } = {}
) {
  const connectOverCDP = options.connectOverCDP ?? vi.fn();
  const fetch =
    options.fetch ??
    (vi.fn(async () => {
      throw new Error("unexpected fetch");
    }) as typeof globalThis.fetch);
  const readFile =
    options.readFile ??
    (vi.fn(async (filePath: string) => {
      throw createEnoentError(filePath);
    }) as ReturnType<typeof vi.fn>);

  const manager = new BrowserManager(path.join("/tmp", "dev-browser-auto-connect-tests"), {
    connectOverCDP: connectOverCDP as never,
    fetch,
    homedir: options.homedir ?? (() => "/Users/tester"),
    launchPersistentContext: vi.fn() as never,
    mkdir: vi.fn(async () => undefined) as never,
    platform: options.platform ?? "darwin",
    readFile: readFile as never,
  });

  return {
    manager,
    connectOverCDP,
    fetch,
    readFile,
  };
}

function getInternals(manager: BrowserManager): BrowserManagerInternals {
  return manager as unknown as BrowserManagerInternals;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BrowserManager auto-connect", () => {
  it("parses DevToolsActivePort and returns the browser websocket endpoint", async () => {
    const homeDir = "/Users/tester";
    const devToolsPath = path.join(
      homeDir,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "DevToolsActivePort"
    );
    const websocketUrl = "ws://127.0.0.1:9333/devtools/browser/from-port-file";
    const readFile = vi.fn(async (filePath: string) => {
      if (filePath === devToolsPath) {
        return "9333\n/devtools/browser/from-port-file\n";
      }

      throw createEnoentError(filePath);
    });
    const { manager } = createManager({
      homedir: () => homeDir,
      readFile,
    });

    await expect(getInternals(manager).readDevToolsActivePort()).resolves.toBe(websocketUrl);
  });

  it("checks Windows Chrome-family DevToolsActivePort locations", async () => {
    const homeDir = "C:\\Users\\tester";
    const devToolsPath = path.join(
      homeDir,
      "AppData",
      "Local",
      "Google",
      "Chrome",
      "User Data",
      "DevToolsActivePort"
    );
    const readFile = vi.fn(async (filePath: string) => {
      if (filePath === devToolsPath) {
        return "9222\n/devtools/browser/windows-port-file\n";
      }

      throw createEnoentError(filePath);
    });
    const { manager } = createManager({
      homedir: () => homeDir,
      platform: "win32",
      readFile,
    });

    await expect(getInternals(manager).readDevToolsActivePort()).resolves.toBe(
      "ws://127.0.0.1:9222/devtools/browser/windows-port-file"
    );
  });

  it("returns null when DevToolsActivePort is missing", async () => {
    const { manager } = createManager();

    await expect(getInternals(manager).readDevToolsActivePort()).resolves.toBeNull();
  });

  it("ignores malformed DevToolsActivePort files", async () => {
    const homeDir = "/Users/tester";
    const malformedPath = path.join(
      homeDir,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "DevToolsActivePort"
    );
    const readFile = vi.fn(async (filePath: string) => {
      if (filePath === malformedPath) {
        return "not-a-port\n/not-a-browser-path\n";
      }

      throw createEnoentError(filePath);
    });
    const { manager } = createManager({
      homedir: () => homeDir,
      readFile,
    });

    await expect(getInternals(manager).readDevToolsActivePort()).resolves.toBeNull();
  });

  it("discovers Chrome by trying DevToolsActivePort before common ports", async () => {
    const homeDir = "/Users/tester";
    const devToolsPath = path.join(
      homeDir,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "DevToolsActivePort"
    );
    const requests: string[] = [];
    const websocketUrl = "ws://127.0.0.1:9555/devtools/browser/from-discovery";
    const readFile = vi.fn(async (filePath: string) => {
      if (filePath === devToolsPath) {
        return "9555\n/devtools/browser/from-discovery\n";
      }

      throw createEnoentError(filePath);
    });
    const fetch = vi.fn() as typeof globalThis.fetch;
    const { manager } = createManager({ fetch, homedir: () => homeDir, readFile });

    await expect(getInternals(manager).discoverChrome()).resolves.toBe(websocketUrl);
    expect(requests).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("probes a running CDP port via /json/version", async () => {
    const websocketUrl = "ws://127.0.0.1/devtools/browser/probed";
    const server = createServer((request, response) => {
      if (request.url !== "/json/version") {
        response.statusCode = 404;
        response.end();
        return;
      }

      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ webSocketDebuggerUrl: websocketUrl }));
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to resolve server port");
      }

      const { manager } = createManager({
        fetch: globalThis.fetch,
      });

      await expect(getInternals(manager).probePort(address.port)).resolves.toBe(websocketUrl);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  });

  it("connectBrowser resolves HTTP endpoints, registers a connected browser, and creates fresh named pages", async () => {
    const existingPage = new MockPage({
      targetId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      title: "Existing tab",
      url: "https://example.com/existing",
    });
    const context = new MockContext([existingPage]);
    const browser = new MockBrowser([context]);
    const connectOverCDP = vi.fn(async () => browser);
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("http://127.0.0.1:9222/json/version");
      return new Response(
        JSON.stringify({
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/connected-browser",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }
      );
    }) as typeof globalThis.fetch;
    const { manager } = createManager({
      connectOverCDP,
      fetch,
    });

    await manager.connectBrowser("attached", "http://127.0.0.1:9222");
    const namedPage = await manager.getPage("attached", "dashboard");

    expect(connectOverCDP).toHaveBeenCalledWith(
      "ws://127.0.0.1:9222/devtools/browser/connected-browser"
    );
    expect(namedPage).not.toBe(existingPage);
    expect(context.newPageCalls).toBe(1);
    await expect(manager.listPages("attached")).resolves.toEqual([
      {
        id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        name: null,
        title: "Existing tab",
        url: "https://example.com/existing",
      },
      {
        id: "00000000000000000000000000000001",
        name: "dashboard",
        title: "",
        url: "about:blank",
      },
    ]);
    expect(manager.listBrowsers()).toEqual([
      {
        name: "attached",
        pages: ["dashboard"],
        status: "connected",
        type: "connected",
      },
    ]);
  });

  it("getBrowser returns connected entries without relaunching them", async () => {
    const browser = new MockBrowser([new MockContext()]);
    const connectOverCDP = vi.fn(async () => browser);
    const { manager } = createManager({
      connectOverCDP,
    });

    await manager.connectBrowser(
      "attached",
      "ws://127.0.0.1:9222/devtools/browser/external-session"
    );

    const entry = manager.getBrowser("attached");

    expect(entry).toMatchObject({
      name: "attached",
      type: "connected",
      browser,
    });
    expect(connectOverCDP).toHaveBeenCalledTimes(1);

    browser.disconnect();

    expect(manager.getBrowser("attached")).toBeUndefined();
  });

  it("connectBrowser falls back to DevToolsActivePort when /json/version returns 404", async () => {
    const homeDir = "/Users/tester";
    const devToolsPath = path.join(
      homeDir,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "DevToolsActivePort"
    );
    const browser = new MockBrowser([new MockContext()]);
    const connectOverCDP = vi.fn(async () => browser);
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("http://127.0.0.1:9222/json/version");
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;
    const readFile = vi.fn(async (filePath: string) => {
      if (filePath === devToolsPath) {
        return "9222\n/devtools/browser/from-active-port\n";
      }

      throw createEnoentError(filePath);
    });
    const { manager } = createManager({
      connectOverCDP,
      fetch,
      homedir: () => homeDir,
      readFile,
    });

    await manager.connectBrowser("attached", "http://127.0.0.1:9222");

    expect(connectOverCDP).toHaveBeenCalledWith(
      "ws://127.0.0.1:9222/devtools/browser/from-active-port"
    );
  });

  it("reports a helpful error when /json/version returns 404 and no matching DevToolsActivePort exists", async () => {
    const homeDir = "/Users/tester";
    const readFile = vi.fn(async (filePath: string) => {
      if (filePath.endsWith("DevToolsActivePort")) {
        return "9333\n/devtools/browser/different-port\n";
      }

      throw createEnoentError(filePath);
    });
    const fetch = vi.fn(
      async () => new Response("not found", { status: 404 })
    ) as typeof globalThis.fetch;
    const { manager } = createManager({
      fetch,
      homedir: () => homeDir,
      readFile,
    });

    let error: Error | undefined;
    try {
      await manager.connectBrowser("missing", "http://127.0.0.1:9222");
    } catch (reason) {
      error = reason as Error;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/DevToolsActivePort/);
    expect(error?.message).toMatch(/remote-debugging-port=9222/);
  });

  it("keeps external browsers alive on stopAll by only closing the CDP connection", async () => {
    const context = new MockContext();
    const browser = new MockBrowser([context]);
    const connectOverCDP = vi.fn(async () => browser);
    const { manager } = createManager({
      connectOverCDP,
    });

    await manager.connectBrowser(
      "attached",
      "ws://127.0.0.1:9222/devtools/browser/external-session"
    );
    await manager.stopAll();

    expect(browser.closeCalls).toBe(1);
    expect(context.closeCalls).toBe(0);
    expect(manager.browserCount()).toBe(0);
  });

  it("autoConnect falls through discovery methods until a browser is found", async () => {
    const browser = new MockBrowser([new MockContext()]);
    const requests: string[] = [];
    const connectOverCDP = vi.fn(async () => browser);
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);

      if (url === "http://127.0.0.1:9223/json/version") {
        return new Response(
          JSON.stringify({
            webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/discovered",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        );
      }

      throw new Error("connection refused");
    }) as typeof globalThis.fetch;
    const readFile = vi.fn(async (filePath: string) => {
      throw createEnoentError(filePath);
    });
    const { manager } = createManager({
      connectOverCDP,
      fetch,
      readFile,
    });

    await manager.autoConnect("auto-browser");

    expect(requests.slice(0, 2)).toEqual([
      "http://127.0.0.1:9222/json/version",
      "http://127.0.0.1:9223/json/version",
    ]);
    expect(connectOverCDP).toHaveBeenCalledWith("ws://127.0.0.1:9223/devtools/browser/discovered");
    expect(manager.listBrowsers()).toEqual([
      {
        name: "auto-browser",
        pages: [],
        status: "connected",
        type: "connected",
      },
    ]);
  });

  it("autoConnect falls back from DevToolsActivePort to port probing when the direct websocket is stale", async () => {
    const homeDir = "/Users/tester";
    const devToolsPath = path.join(
      homeDir,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "DevToolsActivePort"
    );
    const staleEndpoint = "ws://127.0.0.1:9222/devtools/browser/from-active-port";
    const discoveredEndpoint = "ws://127.0.0.1:9223/devtools/browser/discovered";
    const browser = new MockBrowser([new MockContext()]);
    const requests: string[] = [];
    const connectOverCDP = vi.fn(async (endpoint: string) => {
      if (endpoint === staleEndpoint) {
        throw new Error("stale DevToolsActivePort");
      }

      return browser;
    });
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);

      if (url === "http://127.0.0.1:9222/json/version") {
        return new Response("not found", { status: 404 });
      }

      if (url === "http://127.0.0.1:9223/json/version") {
        return new Response(
          JSON.stringify({
            webSocketDebuggerUrl: discoveredEndpoint,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        );
      }

      throw new Error("connection refused");
    }) as typeof globalThis.fetch;
    const readFile = vi.fn(async (filePath: string) => {
      if (filePath === devToolsPath) {
        return "9222\n/devtools/browser/from-active-port\n";
      }

      throw createEnoentError(filePath);
    });
    const { manager } = createManager({
      connectOverCDP,
      fetch,
      homedir: () => homeDir,
      readFile,
    });

    await manager.autoConnect("auto-browser");

    expect(connectOverCDP).toHaveBeenCalledTimes(2);
    expect(connectOverCDP).toHaveBeenNthCalledWith(1, staleEndpoint);
    expect(connectOverCDP).toHaveBeenNthCalledWith(2, discoveredEndpoint);
    expect(requests).toEqual([
      "http://127.0.0.1:9222/json/version",
      "http://127.0.0.1:9223/json/version",
    ]);
  });

  it("reports a clear error when auto-discovery finds no running Chrome", async () => {
    const readFile = vi.fn(async (filePath: string) => {
      throw createEnoentError(filePath);
    });
    const fetch = vi.fn(async () => {
      throw new Error("connection refused");
    }) as typeof globalThis.fetch;
    const { manager } = createManager({
      fetch,
      readFile,
    });

    await expect(manager.autoConnect("missing")).rejects.toThrowError(/remote-debugging-port=9222/);
  });

  it("reports a Windows-specific launch hint when auto-discovery fails on Windows", async () => {
    const readFile = vi.fn(async () => {
      throw createEnoentError(
        "C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\User Data\\DevToolsActivePort"
      );
    });
    const fetch = vi.fn(async () => {
      throw new Error("connection refused");
    }) as typeof globalThis.fetch;
    const { manager } = createManager({
      fetch,
      platform: "win32",
      readFile,
    });

    await expect(manager.autoConnect("missing")).rejects.toThrowError(
      /chrome\.exe --remote-debugging-port=9222/
    );
  });
});

describe("protocol execute request", () => {
  it('accepts connect="auto" and explicit CDP URLs', () => {
    const autoResult = parseRequest(
      JSON.stringify({
        id: "req-auto",
        type: "execute",
        browser: "default",
        script: 'console.log("hi")',
        connect: "auto",
      })
    );
    const manualResult = parseRequest(
      JSON.stringify({
        id: "req-manual",
        type: "execute",
        browser: "default",
        script: 'console.log("hi")',
        connect: "http://127.0.0.1:9222",
      })
    );

    expect(autoResult).toEqual({
      success: true,
      request: {
        id: "req-auto",
        type: "execute",
        browser: "default",
        script: 'console.log("hi")',
        connect: "auto",
      },
    });
    expect(manualResult).toEqual({
      success: true,
      request: {
        id: "req-manual",
        type: "execute",
        browser: "default",
        script: 'console.log("hi")',
        connect: "http://127.0.0.1:9222",
      },
    });
  });

  it("accepts an execution timeout", () => {
    const result = parseRequest(
      JSON.stringify({
        id: "req-timeout",
        type: "execute",
        browser: "default",
        script: 'console.log("hi")',
        timeoutMs: 10_000,
      })
    );

    expect(result).toEqual({
      success: true,
      request: {
        id: "req-timeout",
        type: "execute",
        browser: "default",
        script: 'console.log("hi")',
        timeoutMs: 10_000,
      },
    });
  });
});
