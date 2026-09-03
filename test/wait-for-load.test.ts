import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeBrowser, withPage } from "./helpers/browser.ts";
import { installLoadTracker } from "../src/page/wait-for-load.ts";
import { sleep, startServer, type FixtureServer } from "./helpers/server.ts";

let srv: FixtureServer;

beforeAll(async () => {
  srv = await startServer({
    "/static": "<!doctype html><h1>static</h1><p>nothing happens</p>",
    "/slow": async () => {
      await sleep(700);
      return new Response("slow-ok", { headers: { "content-type": "text/plain" } });
    },
    "/fetch-then-append": `<!doctype html><h1>fetching</h1>
      <script>
        fetch("/slow").then(r => r.text()).then(t => {
          const el = document.createElement("div"); el.id = "appended"; el.textContent = t;
          document.body.appendChild(el);
        });
      </script>`,
    "/hold": () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
            // never close; keep pinging so the connection stays alive
            const iv = setInterval(() => {
              try {
                controller.enqueue(new TextEncoder().encode(": ping\n\n"));
              } catch {
                clearInterval(iv);
              }
            }, 1000);
            setTimeout(() => {
              clearInterval(iv);
              try {
                controller.close();
              } catch {}
            }, 8000);
          },
        }),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
      ),
    "/long-poll": `<!doctype html><h1>long poll</h1>
      <script>
        fetch("/hold").then(r => r.text()).catch(() => {});
        new EventSource("/hold");
      </script>`,
    "/mutate-forever": `<!doctype html><h1>busy</h1><div id="c"></div>
      <script>
        let i = 0;
        setInterval(() => { document.getElementById("c").textContent = "tick " + (i++); }, 50);
      </script>`,
  });
});

afterAll(async () => {
  await srv.stop();
  await closeBrowser();
});

describe("page.waitForLoad", () => {
  test("static page -> ready quickly", async () => {
    await withPage(async (page) => {
      await page.goto(srv.url("/static"));
      const r = await page.waitForLoad();
      console.log("static:", r);
      expect(r.ready).toBe(true);
      expect(r.readyState).toBe("complete");
      expect(r.pending).toBe(0);
      expect(r.ms).toBeLessThan(600);
    });
  });

  test("fetch /slow then append DOM -> ready only after settle", async () => {
    await withPage(async (page) => {
      // extendPage() is expected to call this eagerly; until then do it here so
      // requests started before the first waitForLoad() call are tracked.
      installLoadTracker(page);
      await page.goto(srv.url("/fetch-then-append"));
      const r = await page.waitForLoad();
      console.log("fetch-then-append:", r);
      expect(r.ready).toBe(true);
      expect(r.ms).toBeGreaterThanOrEqual(700);
      expect(r.ms).toBeLessThan(2000);
      const txt = await page.$eval("#appended", (el) => el.textContent);
      expect(txt).toBe("slow-ok");
    });
  });

  test("never-ending stream/long-poll -> ignored once older than 2 s", async () => {
    await withPage(async (page) => {
      installLoadTracker(page);
      await page.goto(srv.url("/long-poll"));
      const r = await page.waitForLoad({ timeout: 4000 });
      console.log("long-poll:", r);
      expect(r.ready).toBe(true);
      expect(r.pending).toBe(0);
      expect(r.ms).toBeGreaterThanOrEqual(1500);
      expect(r.ms).toBeLessThan(3000);
    });
  });

  test("DOM mutating forever -> ready:false at timeout", async () => {
    await withPage(async (page) => {
      await page.goto(srv.url("/mutate-forever"));
      const r = await page.waitForLoad({ timeout: 1000 });
      console.log("mutate-forever:", r);
      expect(r.ready).toBe(false);
      expect(r.readyState).toBe("complete");
      expect(r.ms).toBeGreaterThanOrEqual(1000);
      expect(r.ms).toBeLessThan(1500);
    });
  });

  test("called mid-navigation -> does not throw", async () => {
    await withPage(async (page) => {
      await page.goto(srv.url("/static"));
      const nav = page.goto(srv.url("/fetch-then-append"));
      const r = await page.waitForLoad();
      console.log("mid-navigation:", r);
      await nav;
      expect(typeof r.ready).toBe("boolean");
      expect(r.ms).toBeLessThanOrEqual(3500);
      // After the navigation settles, a second call reports ready.
      const r2 = await page.waitForLoad();
      expect(r2.ready).toBe(true);
    });
  });

  test("default timeout is 3000 ms", async () => {
    await withPage(async (page) => {
      await page.goto(srv.url("/mutate-forever"));
      const r = await page.waitForLoad();
      console.log("default-timeout:", r);
      expect(r.ready).toBe(false);
      expect(r.ms).toBeGreaterThanOrEqual(3000);
      expect(r.ms).toBeLessThan(3600);
    });
  });
});
