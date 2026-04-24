import { afterEach, describe, expect, it, vi } from "vitest";

import { createLiveCdpBrowser, type LiveCdpTransport } from "./live-cdp-browser.js";

type CdpMessage = {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

class MockLiveCdpTransport implements LiveCdpTransport {
  readonly sent: CdpMessage[] = [];
  readonly hangingMethods = new Set<string>();
  targetInfos = [
    {
      targetId: "target-1",
      type: "page",
      url: "https://example.com/",
      title: "Existing",
    },
  ];

  #closed = false;
  #messageListeners = new Set<(message: string) => void>();
  #closeListeners = new Set<(reason?: string) => void>();

  send(message: string): void {
    const request = JSON.parse(message) as CdpMessage;
    this.sent.push(request);
    queueMicrotask(() => {
      this.respond(request);
    });
  }

  close(): void {
    this.#closed = true;
    for (const listener of this.#closeListeners) {
      listener("closed by test");
    }
  }

  onMessage(listener: (message: string) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener: (reason?: string) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  emit(payload: unknown): void {
    for (const listener of this.#messageListeners) {
      listener(JSON.stringify(payload));
    }
  }

  private respond(request: CdpMessage): void {
    if (this.#closed) {
      return;
    }

    if (this.hangingMethods.has(request.method)) {
      return;
    }

    switch (request.method) {
      case "Browser.getVersion":
        this.emit({ id: request.id, result: { product: "Chrome/147.0.0.0" } });
        return;
      case "Target.getTargets":
        this.emit({
          id: request.id,
          result: {
            targetInfos: this.targetInfos,
          },
        });
        return;
      case "Target.attachToTarget":
        this.emit({
          id: request.id,
          result: {
            sessionId: request.params?.targetId === "target-2" ? "session-2" : "session-1",
          },
        });
        return;
      case "Page.enable":
      case "Runtime.enable":
      case "Runtime.runIfWaitingForDebugger":
      case "Network.enable":
        this.emit({ id: request.id, result: {} });
        return;
      case "Page.getFrameTree":
        this.emit({
          id: request.id,
          result: {
            frameTree: {
              frame: {
                id: "frame-1",
              },
            },
          },
        });
        return;
      case "Target.createTarget":
        this.emit({ id: request.id, result: { targetId: "target-2" } });
        return;
      case "Runtime.evaluate":
        this.emit({
          id: request.id,
          result: {
            result:
              request.params?.expression === "document.title"
                ? { type: "string", value: "Live Title" }
                : { type: "number", value: 42 },
          },
        });
        return;
      case "Input.dispatchKeyEvent":
      case "Target.detachFromTarget":
        this.emit({ id: request.id, result: {} });
        return;
      case "Page.navigate":
        this.emit({ id: request.id, result: { frameId: "frame-1" } });
        this.emit({ method: "Page.loadEventFired", sessionId: request.sessionId, params: {} });
        return;
      case "Target.closeTarget":
        this.emit({ id: request.id, result: { success: true } });
        return;
      default:
        this.emit({
          id: request.id,
          error: { message: `Unexpected method ${request.method}` },
        });
    }
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("live-CDP browser adapter", () => {
  it("times out a hung Browser.getVersion handshake with a named step error", async () => {
    vi.useFakeTimers();
    const transport = new MockLiveCdpTransport();
    transport.hangingMethods.add("Browser.getVersion");

    const connectPromise = createLiveCdpBrowser("ws://127.0.0.1/devtools/browser/test", {
      transportFactory: async () => transport,
    });
    const assertion = expect(connectPromise).rejects.toThrow(
      /Timed out after 5000ms initializing live CDP browser during Browser\.getVersion/
    );

    await vi.advanceTimersByTimeAsync(5_000);

    await assertion;
  });

  it("times out a hung Target.getTargets refresh with a named step error", async () => {
    vi.useFakeTimers();
    const transport = new MockLiveCdpTransport();
    const browser = await createLiveCdpBrowser("ws://127.0.0.1/devtools/browser/test", {
      transportFactory: async () => transport,
    });
    transport.hangingMethods.add("Target.getTargets");

    const refreshPromise = browser.refreshPages();
    const assertion = expect(refreshPromise).rejects.toThrow(
      /Timed out after 5000ms initializing live CDP browser during Target\.getTargets/
    );
    await vi.advanceTimersByTimeAsync(5_000);

    await assertion;
  });

  it("attaches to page targets without root Target.setAutoAttach", async () => {
    const transport = new MockLiveCdpTransport();
    const browser = await createLiveCdpBrowser("ws://127.0.0.1/devtools/browser/test", {
      transportFactory: async () => transport,
    });

    const context = browser.contexts()[0];
    expect(context).toBeDefined();
    const page = context!.pages()[0];

    expect(page?.url()).toBe("https://example.com/");
    await expect(page?.title()).resolves.toBe("Live Title");
    await expect(page?.evaluate(() => 42)).resolves.toBe(42);

    expect(transport.sent.map((message) => message.method)).toEqual(
      expect.arrayContaining([
        "Browser.getVersion",
        "Target.getTargets",
        "Target.attachToTarget",
        "Page.enable",
        "Runtime.enable",
        "Network.enable",
      ])
    );
    expect(transport.sent.map((message) => message.method)).not.toContain("Target.setAutoAttach");
    expect(transport.sent.map((message) => message.method)).not.toContain("Runtime.callFunctionOn");
    expect(
      transport.sent.find((message) => message.method === "Target.attachToTarget")?.params
    ).toEqual({
      targetId: "target-1",
      flatten: true,
    });
  });

  it("creates new targets and drives basic navigation over the page session", async () => {
    const transport = new MockLiveCdpTransport();
    const browser = await createLiveCdpBrowser("ws://127.0.0.1/devtools/browser/test", {
      transportFactory: async () => transport,
    });
    const context = browser.contexts()[0];
    expect(context).toBeDefined();
    const page = await context!.newPage();

    await page.goto("https://example.test/");

    expect(transport.sent.map((message) => message.method)).toEqual(
      expect.arrayContaining(["Target.createTarget", "Target.attachToTarget", "Page.navigate"])
    );
    expect(transport.sent.find((message) => message.method === "Page.navigate")).toMatchObject({
      sessionId: "session-2",
      params: {
        url: "https://example.test/",
      },
    });
  });

  it("removes pages when Chrome detaches their target session", async () => {
    const transport = new MockLiveCdpTransport();
    const browser = await createLiveCdpBrowser("ws://127.0.0.1/devtools/browser/test", {
      transportFactory: async () => transport,
    });
    const context = browser.contexts()[0];
    expect(context?.pages()).toHaveLength(1);

    transport.emit({
      method: "Target.detachedFromTarget",
      params: {
        sessionId: "session-1",
      },
    });

    expect(context?.pages()).toHaveLength(0);
  });

  it("tracks same-document navigation for synchronous url reads", async () => {
    const transport = new MockLiveCdpTransport();
    const browser = await createLiveCdpBrowser("ws://127.0.0.1/devtools/browser/test", {
      transportFactory: async () => transport,
    });
    const page = browser.contexts()[0]?.pages()[0];
    expect(page?.url()).toBe("https://example.com/");

    transport.emit({
      method: "Page.navigatedWithinDocument",
      sessionId: "session-1",
      params: {
        frameId: "frame-1",
        url: "https://example.com/chat/c/123",
      },
    });

    expect(page?.url()).toBe("https://example.com/chat/c/123");
  });

  it("types text as per-character key events", async () => {
    const transport = new MockLiveCdpTransport();
    const browser = await createLiveCdpBrowser("ws://127.0.0.1/devtools/browser/test", {
      transportFactory: async () => transport,
    });
    const page = browser.contexts()[0]?.pages()[0];

    await page?.keyboard.type("ab");

    const keyEvents = transport.sent.filter((message) => message.method === "Input.dispatchKeyEvent");
    expect(keyEvents).toHaveLength(6);
    expect(keyEvents.map((message) => message.params?.type)).toEqual([
      "keyDown",
      "char",
      "keyUp",
      "keyDown",
      "char",
      "keyUp",
    ]);
    expect(transport.sent.map((message) => message.method)).not.toContain("Input.insertText");
  });

  it("ignores same-document navigation from subframes", async () => {
    const transport = new MockLiveCdpTransport();
    const browser = await createLiveCdpBrowser("ws://127.0.0.1/devtools/browser/test", {
      transportFactory: async () => transport,
    });
    const page = browser.contexts()[0]?.pages()[0];
    expect(page?.url()).toBe("https://example.com/");

    transport.emit({
      method: "Page.navigatedWithinDocument",
      sessionId: "session-1",
      params: {
        frameId: "subframe-1",
        url: "https://embedded.example/path",
      },
    });

    expect(page?.url()).toBe("https://example.com/");
  });

  it("prioritizes yoetz-owned targets before pre-existing tabs", async () => {
    const transport = new MockLiveCdpTransport();
    transport.targetInfos = [
      {
        targetId: "target-existing",
        type: "page",
        url: "https://example.com/",
        title: "Existing",
      },
      {
        targetId: "target-yoetz",
        type: "page",
        url: "https://chatgpt.com/?_yoetz=run-1",
        title: "Yoetz",
      },
    ];

    await createLiveCdpBrowser("ws://127.0.0.1/devtools/browser/test", {
      transportFactory: async () => transport,
    });

    const attachedTargets = transport.sent
      .filter((message) => message.method === "Target.attachToTarget")
      .map((message) => message.params?.targetId);
    expect(attachedTargets).toEqual(["target-yoetz"]);
  });
});
