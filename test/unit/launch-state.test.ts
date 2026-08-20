import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let home: string;
let prevHome: string | undefined;
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "doobie-ls-"));
  prevHome = process.env.DOOBIE_HOME;
  process.env.DOOBIE_HOME = home;
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.DOOBIE_HOME;
  else process.env.DOOBIE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test("markCleanExit patches Preferences exit_type and tolerates a missing profile", async () => {
  const { markCleanExit } = await import("../../src/daemon/sources/launch.ts");
  const dir = path.join(home, "p1");
  expect(markCleanExit(dir)).toBe(true); // no profile yet
  fs.mkdirSync(path.join(dir, "Default"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Default", "Preferences"), JSON.stringify({ profile: { exit_type: "Crashed", name: "x" }, other: 1 }));
  expect(markCleanExit(dir)).toBe(true);
  const j = JSON.parse(fs.readFileSync(path.join(dir, "Default", "Preferences"), "utf8"));
  expect(j.profile.exit_type).toBe("Normal");
  expect(j.profile.exited_cleanly).toBe(true);
  expect(j.profile.name).toBe("x");
  expect(j.other).toBe(1);
  fs.writeFileSync(path.join(dir, "Default", "Preferences"), "{not json");
  expect(markCleanExit(dir)).toBe(false);
});

test("needsNoSandbox reads the remembered set from launch-state.json", async () => {
  const { needsNoSandbox } = await import("../../src/daemon/sources/launch.ts");
  expect(needsNoSandbox("/x/chrome")).toBe(false);
  fs.writeFileSync(path.join(home, "launch-state.json"), JSON.stringify({ noSandbox: ["/x/chrome"] }));
  expect(needsNoSandbox("/x/chrome")).toBe(true);
  expect(needsNoSandbox("/y/chrome")).toBe(false);
});
