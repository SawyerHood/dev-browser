import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { migrateFromDoobie } from "../../src/cli/commands/migrate-from-doobie.ts";

const roots: string[] = [];
const previousSource = process.env.DOOBIE_HOME;
const previousTarget = process.env.DEV_BROWSER_HOME;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (previousSource === undefined) delete process.env.DOOBIE_HOME;
  else process.env.DOOBIE_HOME = previousSource;
  if (previousTarget === undefined) delete process.env.DEV_BROWSER_HOME;
  else process.env.DEV_BROWSER_HOME = previousTarget;
});

function setup(): { source: string; target: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-browser-migrate-"));
  roots.push(root);
  const source = path.join(root, "doobie");
  const target = path.join(root, "dev-browser-v1");
  fs.mkdirSync(path.join(source, "browsers", "work"), { recursive: true });
  fs.writeFileSync(path.join(source, "config.json"), '{"headless":true}\n');
  fs.writeFileSync(path.join(source, "browsers", "work", "cookie"), "kept");
  process.env.DOOBIE_HOME = source;
  process.env.DEV_BROWSER_HOME = target;
  return { source, target };
}

test("copies durable state and leaves the source intact", () => {
  const { source, target } = setup();
  expect(migrateFromDoobie()).toBe(0);
  expect(fs.readFileSync(path.join(target, "config.json"), "utf8")).toContain("headless");
  expect(fs.readFileSync(path.join(target, "browsers", "work", "cookie"), "utf8")).toBe("kept");
  expect(fs.existsSync(path.join(source, "config.json"))).toBe(true);
});

test("refuses to overwrite existing v1 state", () => {
  const { target } = setup();
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "config.json"), "existing");
  expect(migrateFromDoobie()).toBe(1);
  expect(fs.readFileSync(path.join(target, "config.json"), "utf8")).toBe("existing");
});

test("refuses to copy while the doobie daemon is running", () => {
  const { source, target } = setup();
  fs.writeFileSync(path.join(source, "daemon.pid"), String(process.pid));
  expect(migrateFromDoobie()).toBe(1);
  expect(fs.existsSync(target)).toBe(false);
});
