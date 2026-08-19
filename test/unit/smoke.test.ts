import { test, expect, afterAll } from "bun:test";
import { withPage, closeBrowser } from "../helpers/browser.ts";
import { startServer } from "../helpers/server.ts";
import { makeCliEnv } from "../helpers/cli.ts";

afterAll(async () => {
  await closeBrowser();
});

test("fixture page + server", async () => {
  const srv = await startServer({ "/": "<h1 id=t>hello</h1>" });
  try {
    await withPage(async (page) => {
      await page.goto(srv.url("/"));
      expect(await page.$eval("#t", (e) => e.textContent)).toBe("hello");
    });
  } finally {
    await srv.stop();
  }
});

test("cli env runs -e", async () => {
  const cli = makeCliEnv();
  try {
    const r = await cli.run(["--headless", "-e", "1+1"]);
    expect(r.stdout.trim()).toBe("2");
    expect(r.code).toBe(0);
  } finally {
    await cli.cleanup();
  }
});
