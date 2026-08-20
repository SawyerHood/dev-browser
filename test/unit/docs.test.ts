/**
 * Docs consistency: docs/help.md (embedded in `doobie --help`) must stay within
 * the line budget, carry no claims the review found stale, and its examples must
 * behave as documented (review-2 docs findings).
 */
import { test, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeCliEnv } from "../helpers/cli.ts";
import { startServer } from "../helpers/server.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
const HELP = fs.readFileSync(path.join(ROOT, "docs/help.md"), "utf8");
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const SKILL = fs.readFileSync(path.join(ROOT, "skills/doobie/SKILL.md"), "utf8");
const HANDOFF = fs.readFileSync(path.join(ROOT, "docs/HANDOFF.md"), "utf8");
const DESIGN = fs.readFileSync(path.join(ROOT, "docs/design-decisions.md"), "utf8");

const cli = makeCliEnv("doobie-docs-");
afterAll(async () => {
  await cli.cleanup();
});

function section(name: string): string {
  const parts = HELP.split("\n## ");
  const hit = parts.find((p) => p.startsWith(`${name}\n`));
  if (!hit) throw new Error(`no help section ${name}`);
  return hit.slice(name.length + 1);
}

test("help.md stays within the line budget and every topic is present", () => {
  expect(HELP.replace(/\n$/, "").split("\n").length).toBeLessThanOrEqual(320); // as `wc -l`
  for (const t of "quickstart workflow scripts pages snapshot refs screenshots waiting forms errors output connect chrome config json mcp examples tips".split(" ")) {
    expect(HELP).toContain(`\n## ${t}\n`);
  }
  // usage line and chrome section advertise --headless
  expect(HELP).toContain("doobie chrome [--profile NAME] [--port N] [--chrome PATH] [--headless] [--list] [URL]");
  expect(section("chrome")).toContain("--headless");
  expect(section("chrome")).toContain("/json/version");
  expect(section("chrome")).toContain("chrome-logs/NAME.log");
});

test("help.md no longer carries the stale claims from the review", () => {
  expect(HELP).not.toContain("not two on one page");
  expect(HELP).not.toContain("-> TypeError");
  expect(HELP).not.toContain('"await p.$$eval(".athing .titleline a"');
  expect(HELP).toContain('.athing .titleline > a');
  expect(HELP).not.toContain("lists tabs for every running browser\n  (with -b/--connect it launches/attaches that browser first)");
  expect(HELP).toContain("lists only its tabs");
  const scripts = section("scripts");
  expect(scripts).toContain("ReferenceError");
  expect(scripts).toContain("synchronous CPU-bound code");
  expect(scripts).toContain("bring-to-front lock");
  expect(scripts).toContain("Two scripts on one named page interleave");
  expect(scripts).toMatch(/setDefaultTimeout.*setRequestInterception\(true\)/);
  const pages = section("pages");
  expect(pages).toContain("BrowserStoppedError");
  expect(pages).toContain("only tabs you touch");
  expect(pages).toContain("downloads/<name>");
  expect(pages).toContain("ERR_ABORTED");
  expect(pages).toMatch(/`pages`\/`status`/);
  const refs = section("refs");
  expect(refs).toContain("page.$/$$ return null/[]");
  expect(refs).toContain("TimeoutError");
  const forms = section("forms");
  expect(forms).toContain("pdf({ path })");
  expect(forms).toContain("auto-accepted");
  const errors = section("errors");
  expect(errors).toContain("BrowserStoppedError");
  expect(errors).toContain('(goto "URL" failed)');
  expect(errors).toContain("help <unknown topic>");
  expect(section("snapshot")).toContain('button "Choose File"');
});

test("README, SKILL, HANDOFF and design doc reflect the current behaviour", () => {
  expect(README).toContain("medians of 9 runs");
  expect(README).not.toContain("~570 ms");
  expect(README).toContain("DOOBIE_DOWNLOAD_BASE");
  expect(README).toContain("## Releasing");
  expect(README).toContain("bring-to-front lock");
  expect(SKILL).toContain("bun add -g doobie");
  expect(HANDOFF).toContain("v0.1.0-rc.1");
  expect(HANDOFF).toContain("DOOBIE_DOWNLOAD_BASE");
  expect(DESIGN).toContain("BrowserStoppedError");
  expect(DESIGN).toContain("auto-accepted");
  expect(DESIGN).not.toContain("`serve`/MCP");
});

test("documented behaviours hold: help exit 2, ASI ReferenceError, stale ref $ -> null, ref wait is a TimeoutError, pages -b", async () => {
  const bogus = await cli.run(["help", "bogus-topic"]);
  expect(bogus.code).toBe(2);
  expect(bogus.stderr).toContain('No help topic "bogus-topic"');

  const asi = await cli.run(["--headless"], {
    stdin: 'const p = await browser.getPage("docs")\n(await p.shot()).path\n',
  });
  expect(asi.code).toBe(1);
  expect(asi.stderr).toContain("ReferenceError: Cannot access 'p' before initialization");

  const srv = await startServer({
    "/": '<a id=l href="/two">two</a><input type=file id=f><input placeholder=Search>',
    "/two": "<h1>two</h1>",
  });
  try {
    const snap = await cli.run([
      "--headless",
      "-e",
      `const p = await browser.getPage("docs"); await p.goto(${JSON.stringify(srv.url("/"))}); await p.snapshot()`,
    ]);
    expect(snap.stdout).toContain('button "Choose File"');
    expect(snap.stdout).toContain('textbox "Search"');

    const stale = await cli.run([
      "--headless",
      "-e",
      `const p = await browser.getPage("docs"); await p.goto(${JSON.stringify(srv.url("/two"))}); ({ one: await p.$("ref/e1"), all: await p.$$("ref/e1") })`,
    ]);
    expect(stale.code).toBe(0);
    expect(JSON.parse(stale.stdout)).toEqual({ one: null, all: [] });

    const wait = await cli.run([
      "--headless",
      "-e",
      `const p = await browser.getPage("docs"); let r; try { await p.waitForSelector("ref/e1", { timeout: 300 }) } catch (e) { r = { name: e.name, msg: e.message } } r`,
    ]);
    const parsed = JSON.parse(wait.stdout);
    expect(parsed.name).toBe("TimeoutError");
    expect(parsed.msg).toContain("Waiting for selector `ref/e1` failed");
  } finally {
    await srv.stop();
  }

  // `pages -b NAME` launches that browser and lists only its tabs
  const one = await cli.run(["--headless", "-b", "docs-b", "pages"]);
  expect(one.stdout).toContain("docs-b:headless:");
  expect(one.stdout).not.toContain("default:headless:");
  const all = await cli.run(["--headless", "pages"]);
  expect(all.stdout).toContain("default:headless:");
  expect(all.stdout).toContain("docs-b:headless:");
}, 120_000);
