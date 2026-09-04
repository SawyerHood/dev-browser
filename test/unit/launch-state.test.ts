import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let home: string;
let prevHome: string | undefined;
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dev-browser-ls-"));
  prevHome = process.env.DEV_BROWSER_HOME;
  process.env.DEV_BROWSER_HOME = home;
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.DEV_BROWSER_HOME;
  else process.env.DEV_BROWSER_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test("preparePrefs creates/patches Preferences: clean exit, leak detection off, no password/autofill UI", async () => {
  const { preparePrefs } = await import("../../src/daemon/sources/launch.ts");
  const dir = path.join(home, "p1");
  expect(preparePrefs(dir)).toBe(true); // fresh profile: file is created
  let j = JSON.parse(fs.readFileSync(path.join(dir, "Default", "Preferences"), "utf8"));
  expect(j.profile.password_manager_leak_detection).toBe(false);
  expect(j.credentials_enable_service).toBe(false);
  expect(j.autofill.profile_enabled).toBe(false);
  fs.writeFileSync(path.join(dir, "Default", "Preferences"), JSON.stringify({ profile: { exit_type: "Crashed", name: "x" }, autofill: { keep: 1 }, other: 1 }));
  expect(preparePrefs(dir)).toBe(true);
  j = JSON.parse(fs.readFileSync(path.join(dir, "Default", "Preferences"), "utf8"));
  expect(j.profile.exit_type).toBe("Normal");
  expect(j.profile.exited_cleanly).toBe(true);
  expect(j.profile.name).toBe("x");
  expect(j.autofill.keep).toBe(1);
  expect(j.other).toBe(1);
  fs.writeFileSync(path.join(dir, "Default", "Preferences"), "{not json");
  expect(preparePrefs(dir)).toBe(false);
});

test("needsNoSandbox reads the remembered set from launch-state.json", async () => {
  const { needsNoSandbox } = await import("../../src/daemon/sources/launch.ts");
  expect(needsNoSandbox("/x/chrome")).toBe(false);
  fs.writeFileSync(path.join(home, "launch-state.json"), JSON.stringify({ noSandbox: ["/x/chrome"] }));
  expect(needsNoSandbox("/x/chrome")).toBe(true);
  expect(needsNoSandbox("/y/chrome")).toBe(false);
});
