import { test, expect, afterAll } from "bun:test";
import { withPage, closeBrowser } from "./helpers/browser.ts";
import { smallHtml } from "../bench/fixtures/small.ts";
import { serpHtml } from "../bench/fixtures/serp.ts";

afterAll(closeBrowser);

const stats = `(() => { const w = document.createTreeWalker(document, NodeFilter.SHOW_ALL); let n = 0; while (w.nextNode()) n++;
  return { nodes: n, elements: document.querySelectorAll('*').length, links: document.querySelectorAll('a[href]').length, buttons: document.querySelectorAll('button').length }; })()`;

test("small fixture is ~3 KB with ~60 elements", async () => {
  const html = smallHtml();
  expect(html.length).toBeGreaterThan(2000);
  expect(html.length).toBeLessThan(4500);
  await withPage(async (page) => {
    await page.setContent(html);
    const s = (await page.evaluate(stats)) as { elements: number };
    expect(s.elements).toBeGreaterThanOrEqual(50);
    expect(s.elements).toBeLessThanOrEqual(80);
  });
});

test("serp fixture has ~1500 nodes, 300 links, 100 buttons", async () => {
  await withPage(async (page) => {
    await page.setContent(serpHtml());
    const s = (await page.evaluate(stats)) as { nodes: number; links: number; buttons: number };
    expect(s.nodes).toBeGreaterThanOrEqual(1400);
    expect(s.nodes).toBeLessThanOrEqual(2200);
    expect(s.links).toBeGreaterThanOrEqual(300);
    expect(s.links).toBeLessThanOrEqual(340);
    expect(s.buttons).toBeGreaterThanOrEqual(100);
    expect(s.buttons).toBeLessThanOrEqual(110);
  });
});
