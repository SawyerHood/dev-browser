/**
 * End-to-end: named pages, anonymous pages, listPages/closePage, `doobie pages`.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeCliEnv, type CliEnv } from "../helpers/cli.ts";
import { startServer, type FixtureServer } from "../helpers/server.ts";

let cli: CliEnv;
let srv: FixtureServer;
const H = ["--headless"];

beforeAll(async () => {
  cli = makeCliEnv("doobie-e2e-pages-");
  srv = await startServer({
    "/a": "<!doctype html><title>Page A</title><p>a</p>",
    "/b": "<!doctype html><title>Page B</title><p>b</p>",
  });
  const r = await cli.run([...H, "-e", "1"]);
  expect(r.code).toBe(0);
});

afterAll(async () => {
  await srv.stop();
  await cli.cleanup();
});

async function listPages(): Promise<Array<{ id: string; name: string | null; url: string; title: string }>> {
  const r = await cli.run([...H, "-e", "await browser.listPages()"]);
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout);
}

describe("named pages", () => {
  test("a named page persists its URL across two invocations", async () => {
    const r1 = await cli.run(H, {
      stdin: `const page = await browser.getPage("keep")\nawait page.goto(${JSON.stringify(srv.url("/a"))})\nawait page.title()`,
    });
    expect(r1).toEqual({ code: 0, stdout: "Page A\n", stderr: "" });
    const r2 = await cli.run(H, { stdin: `const page = await browser.getPage("keep");\n[page.url(), await page.title()]` });
    expect(r2.code).toBe(0);
    expect(JSON.parse(r2.stdout)).toEqual([srv.url("/a"), "Page A"]);
  });

  test("getPage returns the same tab for the same name within one script", async () => {
    const r = await cli.run([...H, "-e", "const a = await browser.getPage('same'); const b = await browser.getPage('same'); a === b"]);
    expect(r.stdout).toBe("true\n");
  });

  test("pages file under DOOBIE_HOME/pages/*.json contains the name -> targetId", async () => {
    const dir = path.join(cli.home, "pages");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files).toEqual(["default__headless.json"]);
    const map = JSON.parse(fs.readFileSync(path.join(dir, files[0]!), "utf8")) as Record<string, string>;
    expect(typeof map.keep).toBe("string");
    expect(map.keep).toMatch(/^[0-9A-F]{32}$/);
    const pages = await listPages();
    expect(pages.find((p) => p.name === "keep")?.id).toBe(map.keep);
  });

  test("getPage by targetId from listPages attaches to the tab without renaming it", async () => {
    const pages = await listPages();
    const keep = pages.find((p) => p.name === "keep")!;
    expect(keep).toBeDefined();
    const r = await cli.run([...H, "-e", `const p = await browser.getPage(${JSON.stringify(keep.id)}); [await p.title(), p.url()]`]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["Page A", srv.url("/a")]);
    // still named "keep", not renamed to the id
    const after = await listPages();
    expect(after.find((p) => p.id === keep.id)?.name).toBe("keep");
  });

  test("getPage with an unknown targetId throws a helpful error", async () => {
    const r = await cli.run([...H, "-e", `await browser.getPage("0123456789ABCDEF0123456789ABCDEF")`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/No page with target id/);
    expect(r.stderr).toMatch(/listPages/);
  });

  test("getPage('') throws a TypeError", async () => {
    const r = await cli.run([...H, "-e", `await browser.getPage("")`]);
    expect(r.code).toBe(1);
    expect(r.stderr.split("\n")[0]).toMatch(/^TypeError: .*non-empty string/);
  });
});

describe("anonymous pages", () => {
  test("newPage is not auto-closed; listPages count grows; closePage by name works", async () => {
    const before = await listPages();
    const r = await cli.run(H, {
      stdin: `const p = await browser.newPage()\nawait p.goto(${JSON.stringify(srv.url("/b"))})\nconst all = await browser.listPages()\nall.find(x => x.url === ${JSON.stringify(srv.url("/b"))})`,
    });
    expect(r.code).toBe(0);
    const created = JSON.parse(r.stdout);
    expect(created.name).toBeNull();
    expect(created.title).toBe("Page B");
    const after = await listPages();
    expect(after.length).toBe(before.length + 1);
    expect(after.some((p) => p.id === created.id && p.name === null)).toBe(true);

    // a named page can be closed by name
    const r2 = await cli.run(H, {
      stdin: `const p = await browser.getPage("tmp")\nawait p.goto(${JSON.stringify(srv.url("/b"))});\n(await browser.listPages()).some(x => x.name === "tmp")`,
    });
    expect(r2.stdout).toBe("true\n");
    const r3 = await cli.run([...H, "-e", `await browser.closePage("tmp"); (await browser.listPages()).some(x => x.name === "tmp")`]);
    expect(r3).toEqual({ code: 0, stdout: "false\n", stderr: "" });
    const map = JSON.parse(fs.readFileSync(path.join(cli.home, "pages", "default__headless.json"), "utf8"));
    expect(map.tmp).toBeUndefined();
    // closePage on an unknown name throws
    const r4 = await cli.run([...H, "-e", `await browser.closePage("nope")`]);
    expect(r4.code).toBe(1);
    expect(r4.stderr).toMatch(/not found/);
  });

  test("closing a named tab with page.close() drops the name and getPage recreates it", async () => {
    const r1 = await cli.run(H, {
      stdin: `const p = await browser.getPage("gone")\nawait p.goto(${JSON.stringify(srv.url("/a"))})\nawait p.close()\nawait new Promise(r => setTimeout(r, 100));\n(await browser.listPages()).some(x => x.name === "gone")`,
    });
    expect(r1.stdout).toBe("false\n");
    const r2 = await cli.run([...H, "-e", `const p = await browser.getPage("gone"); p.url()`]);
    expect(r2).toEqual({ code: 0, stdout: "about:blank\n", stderr: "" });
  });
});

describe("doobie pages", () => {
  test("lists browser key, id, name, url, title", async () => {
    const r = await cli.run(["pages"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("default:headless:");
    const keep = lines.find((l) => l.includes("  keep  "));
    expect(keep).toBeDefined();
    expect(keep).toMatch(new RegExp(`^  [0-9A-F]{32}  keep  ${srv.url("/a").replace(/[.\\/]/g, "\\$&")}  "Page A"$`));
    // anonymous pages show "-"
    expect(lines.some((l) => /^  [0-9A-F]{32}  -  /.test(l))).toBe(true);
  });

  test("--json payload shape", async () => {
    const r = await cli.run(["pages", "--json"]);
    expect(r.code).toBe(0);
    const frames = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    const data = frames.find((f) => f.type === "data");
    expect(Array.isArray(data.payload)).toBe(true);
    expect(data.payload[0].browser).toBe("default:headless");
    const keep = data.payload[0].pages.find((p: { name: string }) => p.name === "keep");
    expect(keep).toMatchObject({ url: srv.url("/a"), title: "Page A" });
    expect(frames[frames.length - 1]).toMatchObject({ type: "done", exitCode: 0 });
  });

  test("listPages entries have the documented shape", async () => {
    const pages = await listPages();
    for (const p of pages) {
      expect(Object.keys(p).sort()).toEqual(["id", "name", "title", "url"]);
      expect(p.id).toMatch(/^[0-9A-F]{32}$/);
    }
  });
});
