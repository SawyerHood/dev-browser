import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { BrowserManager } from "./browser-manager.js";

// Regression test for P0-1: the script-level --timeout budget must propagate to
// the Playwright context's per-action default timeout. Without this, a script
// given `--timeout 90` still had every goto/click/screenshot capped at
// Playwright's fixed 30s default — the field's costliest timeout confusion.
describe("BrowserManager.setDefaultTimeouts", () => {
  function makeManagerWithFakeContext() {
    const setDefaultTimeout = vi.fn();
    const setDefaultNavigationTimeout = vi.fn();
    const fakeContext = {
      setDefaultTimeout,
      setDefaultNavigationTimeout,
      browser: () => ({ isConnected: () => true, on: () => undefined }),
      on: () => undefined,
      pages: () => [],
    };
    const manager = new BrowserManager(
      path.join(os.tmpdir(), "dev-browser-timeout-propagation"),
      {
        launchPersistentContext: vi.fn(async () => fakeContext) as never,
      }
    );
    return { manager, setDefaultTimeout, setDefaultNavigationTimeout };
  }

  it("applies the given budget to both the action and navigation default timeouts", async () => {
    const { manager, setDefaultTimeout, setDefaultNavigationTimeout } =
      makeManagerWithFakeContext();
    await manager.ensureBrowser("t", { headless: true });

    manager.setDefaultTimeouts("t", 90_000);

    expect(setDefaultTimeout).toHaveBeenCalledWith(90_000);
    expect(setDefaultNavigationTimeout).toHaveBeenCalledWith(90_000);
  });

  it("is a safe no-op when the browser is not running", () => {
    const { manager, setDefaultTimeout } = makeManagerWithFakeContext();
    expect(() => manager.setDefaultTimeouts("never-launched", 5_000)).not.toThrow();
    expect(setDefaultTimeout).not.toHaveBeenCalled();
  });
});
