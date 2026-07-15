import { afterEach, describe, expect, it, vi } from "vitest";

import { IdleBrowserReaper, type IdleBrowserSummary } from "./idle-browser-reaper.js";
import { createKeyedLock } from "./lock.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function createHarness(initialBrowsers: IdleBrowserSummary[]) {
  const browsers = new Map(initialBrowsers.map((browser) => [browser.name, browser]));
  const stopped: string[] = [];
  const withBrowserLock = createKeyedLock<string>();
  const reaper = new IdleBrowserReaper({
    listBrowsers: () => [...browsers.values()],
    stopBrowser: async (name) => {
      stopped.push(name);
      browsers.delete(name);
    },
    withBrowserLock,
  });
  return { browsers, reaper, stopped, withBrowserLock };
}

describe("IdleBrowserReaper", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires at the pinned idle deadline despite recurring background work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { reaper, stopped } = createHarness([{ name: "managed", type: "launched" }]);
    reaper.configure(1_000);
    reaper.requestStarted("managed");
    reaper.requestFinished("managed");

    let backgroundTicks = 0;
    const backgroundWork = setInterval(() => {
      backgroundTicks += 1;
    }, 100);

    await vi.advanceTimersByTimeAsync(999);
    expect(backgroundTicks).toBeGreaterThan(0);
    expect(stopped).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toEqual(["managed"]);

    clearInterval(backgroundWork);
    reaper.dispose();
  });

  it("does not close an active request and starts its idle window at completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { reaper, stopped } = createHarness([{ name: "active", type: "launched" }]);
    reaper.configure(100);
    reaper.requestStarted("active");

    await vi.advanceTimersByTimeAsync(500);
    expect(stopped).toEqual([]);
    expect(reaper.idleInfo({ name: "active", type: "launched" }).activeRequests).toBe(1);

    reaper.requestFinished("active");
    await vi.advanceTimersByTimeAsync(99);
    expect(stopped).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toEqual(["active"]);
    reaper.dispose();
  });

  it("tracks idle deadlines independently for each named browser", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { reaper, stopped } = createHarness([
      { name: "first", type: "launched" },
      { name: "second", type: "launched" },
    ]);
    reaper.configure(100);
    reaper.requestStarted("first");
    reaper.requestFinished("first");
    reaper.requestStarted("second");
    reaper.requestFinished("second");

    await vi.advanceTimersByTimeAsync(50);
    reaper.requestStarted("second");
    reaper.requestFinished("second");

    await vi.advanceTimersByTimeAsync(50);
    expect(stopped).toEqual(["first"]);
    await vi.advanceTimersByTimeAsync(50);
    expect(stopped).toEqual(["first", "second"]);
    reaper.dispose();
  });

  it("acquires the browser lock and rechecks activity before closing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { reaper, stopped, withBrowserLock } = createHarness([
      { name: "racing", type: "launched" },
    ]);
    reaper.configure(100);
    reaper.requestStarted("racing");
    reaper.requestFinished("racing");

    const releaseLock = deferred();
    const lockAcquired = deferred();
    const heldLock = withBrowserLock("racing", async () => {
      lockAcquired.resolve();
      await releaseLock.promise;
    });
    await lockAcquired.promise;

    await vi.advanceTimersByTimeAsync(100);
    reaper.requestStarted("racing");
    releaseLock.resolve();
    await heldLock;
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toEqual([]);

    reaper.requestFinished("racing");
    await vi.advanceTimersByTimeAsync(100);
    expect(stopped).toEqual(["racing"]);
    reaper.dispose();
  });

  it("never closes externally connected Chrome", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { reaper, stopped } = createHarness([{ name: "external", type: "connected" }]);
    reaper.configure(100);
    reaper.requestStarted("external");
    reaper.requestFinished("external");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopped).toEqual([]);
    reaper.dispose();
  });

  it("disables cleanup when configured to zero", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { reaper, stopped } = createHarness([{ name: "disabled", type: "launched" }]);
    reaper.configure(100);
    reaper.requestStarted("disabled");
    reaper.requestFinished("disabled");
    reaper.configure(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopped).toEqual([]);
    reaper.dispose();
  });

  it("applies timeout changes without restarting the daemon", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { reaper, stopped } = createHarness([{ name: "managed", type: "launched" }]);
    reaper.configure(1_000);
    reaper.requestStarted("managed");
    reaper.requestFinished("managed");
    await vi.advanceTimersByTimeAsync(200);

    reaper.configure(300);
    await vi.advanceTimersByTimeAsync(99);
    expect(stopped).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toEqual(["managed"]);
    reaper.dispose();
  });
});
