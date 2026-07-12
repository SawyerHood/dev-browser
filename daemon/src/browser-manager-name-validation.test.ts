import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BrowserManager } from "./browser-manager.js";

// Regression test for the --browser path-traversal fix. A browser name becomes a
// directory segment in the on-disk profile path, so a name containing path
// separators or ".." must be rejected before it reaches the filesystem — never
// launching a browser or creating a directory outside baseDir.
describe("BrowserManager --browser name validation", () => {
  const manager = new BrowserManager(path.join(os.tmpdir(), "dev-browser-name-validation"));

  const unsafe = ["../evil", "..\\evil", "a/b", "a\\b", "..", "foo/../bar", "", "/abs"];
  for (const name of unsafe) {
    it(`rejects unsafe --browser name ${JSON.stringify(name)} without launching`, async () => {
      await expect(manager.ensureBrowser(name, { headless: true })).rejects.toThrow(
        /Invalid --browser name/
      );
      await expect(
        manager.connectBrowser(name, "http://127.0.0.1:59999", {})
      ).rejects.toThrow(/Invalid --browser name/);
    });
  }

  it("accepts ordinary names (validation passes; connection failure is unrelated)", async () => {
    // A safe name must NOT be rejected by the validator. It will still fail to
    // connect to a dead endpoint — but with a connection error, not the
    // "Invalid --browser name" guard.
    await expect(
      manager.connectBrowser("agent-3", "http://127.0.0.1:59999", {})
    ).rejects.not.toThrow(/Invalid --browser name/);
  });
});
