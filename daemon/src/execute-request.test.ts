import { afterEach, describe, expect, it, vi } from "vitest";

import { executeRequest, type ExecuteRequestTransport } from "./execute-request.js";
import { createKeyedLock } from "./lock.js";
import type { ExecuteRequest, Response } from "./protocol.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

class FakeTransport implements ExecuteRequestTransport {
  readonly messages: Response[] = [];
  readonly listeners = new Set<() => void>();
  open = true;

  isOpen(): boolean {
    return this.open;
  }

  onDisconnect(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(message: Response): Promise<void> {
    this.messages.push(message);
  }

  disconnect(): void {
    this.open = false;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

function request(id: string, browser = "shared"): ExecuteRequest {
  return {
    id,
    type: "execute",
    browser,
    script: "",
  };
}

describe("executeRequest", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires in the browser queue and never starts later", async () => {
    vi.useFakeTimers();
    const withBrowserLock = createKeyedLock<string>();
    const releaseFirst = deferred();
    const firstStarted = deferred();
    const first = withBrowserLock("shared", async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });
    await firstStarted.promise;

    const transport = new FakeTransport();
    const prepareBrowser = vi.fn(async () => undefined);
    const execution = executeRequest(request("queued"), 50, transport, {
      withBrowserLock,
      prepareBrowser,
      runScript: vi.fn(async () => undefined),
    });

    await vi.advanceTimersByTimeAsync(50);
    await execution;

    expect(prepareBrowser).not.toHaveBeenCalled();
    expect(transport.messages).toEqual([
      {
        id: "queued",
        type: "error",
        message: "Script timed out after 50ms and was terminated.",
      },
    ]);
    expect(transport.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    releaseFirst.resolve();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(prepareBrowser).not.toHaveBeenCalled();
  });

  it("holds the browser lock through disconnect cancellation before the next request", async () => {
    const withBrowserLock = createKeyedLock<string>();
    const firstTransport = new FakeTransport();
    const secondTransport = new FakeTransport();
    const firstRunning = deferred();
    const stopStarted = deferred();
    const allowStop = deferred();
    const events: string[] = [];

    const runScript = async (
      current: ExecuteRequest,
      _output: unknown,
      { signal }: { signal: AbortSignal }
    ) => {
      if (current.id !== "first") {
        events.push("second:run");
        return;
      }

      events.push("first:run");
      firstRunning.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            events.push("first:stop-start");
            stopStarted.resolve();
            void allowStop.promise.then(() => {
              events.push("first:stop-end");
              reject(signal.reason);
            });
          },
          { once: true }
        );
      });
    };

    const dependencies = {
      withBrowserLock,
      prepareBrowser: async (current: ExecuteRequest) => {
        events.push(`${current.id}:prepare`);
      },
      runScript,
    };

    const first = executeRequest(request("first"), 10_000, firstTransport, dependencies);
    await firstRunning.promise;
    firstTransport.disconnect();
    await stopStarted.promise;

    const second = executeRequest(request("second"), 10_000, secondTransport, dependencies);
    await Promise.resolve();
    expect(events).not.toContain("second:prepare");

    allowStop.resolve();
    await first;
    await second;

    expect(firstTransport.messages).toEqual([]);
    expect(secondTransport.messages).toEqual([{ id: "second", type: "complete", success: true }]);
    expect(events).toEqual([
      "first:prepare",
      "first:run",
      "first:stop-start",
      "first:stop-end",
      "second:prepare",
      "second:run",
    ]);
    expect(firstTransport.listeners.size).toBe(0);
    expect(secondTransport.listeners.size).toBe(0);
  });

  it("suppresses output and duplicate terminal frames after the deadline", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const withBrowserLock = createKeyedLock<string>();

    const execution = executeRequest(request("running"), 25, transport, {
      withBrowserLock,
      prepareBrowser: async () => undefined,
      runScript: async (_request, output, { signal }) => {
        output.onStdout("before\n");
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              output.onStdout("late\n");
              output.onStderr("later\n");
              reject(new Error("late inner failure"));
            },
            { once: true }
          );
        });
      },
    });

    await vi.advanceTimersByTimeAsync(25);
    await execution;

    expect(transport.messages).toEqual([
      { id: "running", type: "stdout", data: "before\n" },
      {
        id: "running",
        type: "error",
        message: "Script timed out after 25ms and was terminated.",
      },
    ]);
    expect(transport.messages.filter((message) => message.type === "error")).toHaveLength(1);
    expect(transport.messages.some((message) => message.type === "complete")).toBe(false);
    expect(transport.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves an inner error that wins before the hard deadline", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();

    await executeRequest(request("inner-error"), 1_000, transport, {
      withBrowserLock: createKeyedLock<string>(),
      prepareBrowser: async () => undefined,
      runScript: async () => {
        throw new Error("locator click failed: target closed");
      },
    });

    expect(transport.messages).toHaveLength(1);
    expect(transport.messages[0]).toEqual(
      expect.objectContaining({
        id: "inner-error",
        type: "error",
        message: expect.stringContaining("locator click failed: target closed"),
      })
    );
    expect(transport.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns the deadline error instead of success when the timer callback is delayed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const transport = new FakeTransport();

    await executeRequest(request("boundary"), 100, transport, {
      withBrowserLock: createKeyedLock<string>(),
      prepareBrowser: async () => undefined,
      runScript: async () => {
        vi.setSystemTime(10_100);
      },
    });

    expect(transport.messages).toEqual([
      {
        id: "boundary",
        type: "error",
        message: "Script timed out after 100ms and was terminated.",
      },
    ]);
    expect(transport.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
