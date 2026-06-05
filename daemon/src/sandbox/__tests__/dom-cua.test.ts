import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "../../browser-manager.js";
import { removeDirectoryWithRetries } from "../../test-cleanup.js";
import { domCuaRegister, domCuaWalker } from "../forked-client/src/client/domCuaInjected.js";
import { QuickJSSandbox } from "../quickjs-sandbox.js";
import { runScript } from "../script-runner-quickjs.js";
import { ensureSandboxClientBundle } from "./bundle-test-helpers.js";

const SANDBOX_TIMEOUT_MS = 60_000;

const DOM_TEST_PAGE_HTML = `<!DOCTYPE html>
<html>
  <head>
    <title>DomCua Test Page</title>
  </head>
  <body style="margin:0">
    <input id="name" type="text" placeholder="name here" style="position:absolute;left:20px;top:20px;width:200px" />
    <button id="submit" style="position:absolute;left:20px;top:60px">Submit</button>
    <a id="link" href="https://example.com" style="position:absolute;left:20px;top:100px">Example link</a>
    <input id="check" type="checkbox" checked style="position:absolute;left:20px;top:140px" />
    <div id="closer" role="button" aria-label="Close" tabindex="0" style="position:absolute;left:20px;top:180px">x</div>
    <button id="longtext" style="position:absolute;left:20px;top:220px">${"y".repeat(300)}</button>
    <button id="whitespace" style="position:absolute;left:300px;top:20px">  Hello


      World  </button>
    <button id="escaped" style="position:absolute;left:300px;top:60px">a &amp; b &lt; c</button>
    <input type="hidden" id="hiddenInput" value="secret" />
    <button id="ariaHidden" aria-hidden="true" style="position:absolute;left:300px;top:100px">Hidden A</button>
    <button id="attrHidden" hidden>Hidden B</button>
    <button id="displayNone" style="display:none">Hidden C</button>
    <button id="invisible" style="position:absolute;left:300px;top:140px;visibility:hidden">Hidden D</button>
    <button id="transparent" style="position:absolute;left:300px;top:180px;opacity:0">Hidden E</button>
    <button id="noPointer" style="position:absolute;left:300px;top:220px;pointer-events:none">Hidden F</button>
    <div id="plain" style="position:absolute;left:300px;top:260px">plain text</div>
    <button id="offscreen" style="position:absolute;left:20px;top:2000px">Below the fold</button>
    <div id="spacer" style="width:10px;height:2600px"></div>
  </body>
</html>`;

const HIDDEN_ACT_PAGE_HTML = `<!DOCTYPE html>
<html>
  <body style="margin:0">
    <script>
      window.clicks = [];
      document.addEventListener("click", (event) => window.clicks.push(event.target.id));
    </script>
    <button id="target" style="position:fixed;left:20px;top:20px;width:100px;height:30px">Target</button>
  </body>
</html>`;

const TYPE_ACT_PAGE_HTML = `<!DOCTYPE html>
<html>
  <body style="margin:0">
    <input id="field" type="text" style="position:fixed;left:20px;top:20px;width:200px;height:24px" />
  </body>
</html>`;

const SCROLL_ACT_PAGE_HTML = `<!DOCTYPE html>
<html>
  <body style="margin:0">
    <div id="pane" style="position:fixed;left:600px;top:100px;width:300px;height:200px;overflow:auto">
      <div style="height:1000px">
        <a id="paneLink" href="#pane" style="position:absolute;left:10px;top:10px">Pane link</a>
      </div>
    </div>
    <div style="width:10px;height:3000px"></div>
  </body>
</html>`;

const BUDGET_PAGE_HTML = `<!DOCTYPE html>
<html>
  <body style="margin:0">
    ${Array.from(
      { length: 250 },
      (_, i) =>
        `<a href="#l${i}" style="position:absolute;left:${(i % 50) * 25}px;top:${
          Math.floor(i / 50) * 20
        }px">L${i}</a>`
    ).join("\n    ")}
  </body>
</html>`;

const ID_HELPERS = `
  const idFor = (snapshot, needle) => {
    const line = snapshot.split("\\n").find((entry) => entry.includes(needle));
    if (!line) throw new Error("no snapshot line contains " + needle);
    return Number(line.match(/node_id=(\\d+)/)[1]);
  };
  const allIds = (snapshot) =>
    Array.from(snapshot.matchAll(/node_id=(\\d+)/g)).map((match) => Number(match[1]));
`;

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
}

interface JsonSandboxHarness {
  dispose: () => Promise<void>;
  runJson: <T>(script: string) => Promise<T>;
}

interface DomServer {
  baseUrl: string;
  close: () => Promise<void>;
}

function createOutput(): CapturedOutput & {
  sink: {
    onStdout: (data: string) => void;
    onStderr: (data: string) => void;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    sink: {
      onStdout: (data) => {
        stdout.push(data);
      },
      onStderr: (data) => {
        stderr.push(data);
      },
    },
  };
}

function clearOutput(output: CapturedOutput): void {
  output.stdout.length = 0;
  output.stderr.length = 0;
}

function parseLastJsonLine<T>(output: CapturedOutput): T {
  const lines = output.stdout.map((line) => line.trim()).filter((line) => line.length > 0);
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines.at(-1)!) as T;
}

async function createSandboxHarness(
  manager: BrowserManager,
  browserName: string
): Promise<JsonSandboxHarness> {
  await manager.ensureBrowser(browserName, {
    headless: true,
  });

  const output = createOutput();
  const sandbox = new QuickJSSandbox({
    manager,
    browserName,
    onStdout: output.sink.onStdout,
    onStderr: output.sink.onStderr,
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });

  await sandbox.initialize();

  return {
    dispose: async () => {
      await sandbox.dispose();
    },
    runJson: async <T>(script: string): Promise<T> => {
      clearOutput(output);
      await sandbox.executeScript(`(async () => {\n${script}\n})()`);
      expect(output.stderr).toEqual([]);
      return parseLastJsonLine<T>(output);
    },
  };
}

const RECORDER_SCRIPT = `<script>
  window.clicks = [];
  document.addEventListener("click", (event) => {
    window.clicks.push({ target: event.target.id, x: event.clientX, y: event.clientY });
  });
</script>`;

function manyLinksHtml(count: number, prefix: string): string {
  const links = Array.from(
    { length: count },
    (_, i) =>
      `<a href="#${prefix}${i}" style="position:absolute;left:${(i % 20) * 55}px;top:${
        Math.floor(i / 20) * 22
      }px">${prefix.toUpperCase()}${i}</a>`
  ).join("");
  return `<!DOCTYPE html><html><body style="margin:0">${links}</body></html>`;
}

function domPageHtml(pathname: string): string {
  switch (pathname) {
    case "/dom/first":
      return `<!DOCTYPE html>
<html>
  <head><title>Dom First</title></head>
  <body style="margin:0">
    ${RECORDER_SCRIPT}
    <button id="one" style="position:fixed;left:20px;top:20px;width:120px;height:32px">One</button>
    <button id="two" style="position:fixed;left:20px;top:70px;width:120px;height:32px">Two</button>
    <button id="three" style="position:fixed;left:20px;top:120px;width:120px;height:32px">Three</button>
  </body>
</html>`;
    case "/dom/second":
      return `<!DOCTYPE html>
<html>
  <head><title>Dom Second</title></head>
  <body style="margin:0">
    ${RECORDER_SCRIPT}
    <button id="alpha" style="position:fixed;left:20px;top:20px;width:120px;height:32px">Alpha</button>
    <button id="bravo" style="position:fixed;left:20px;top:70px;width:120px;height:32px">Bravo</button>
    <button id="charlie" style="position:fixed;left:20px;top:120px;width:120px;height:32px">Charlie</button>
    <button id="delta" style="position:fixed;left:20px;top:170px;width:120px;height:32px">Delta</button>
    <button id="echo" style="position:fixed;left:20px;top:220px;width:120px;height:32px">Echo</button>
  </body>
</html>`;
    case "/dom/iframe-host":
      return `<!DOCTYPE html>
<html>
  <head><title>Iframe Host</title></head>
  <body style="margin:0">
    <button id="outer" style="position:fixed;left:10px;top:10px;width:80px;height:30px">Outer</button>
    <iframe id="child" src="/dom/iframe-content" style="position:fixed;left:100px;top:300px;width:400px;height:200px;border:0"></iframe>
  </body>
</html>`;
    case "/dom/iframe-content":
      return `<!DOCTYPE html>
<html>
  <body style="margin:0">
    <script>
      window.frameClicks = [];
      document.addEventListener("click", (event) => {
        window.frameClicks.push({ target: event.target.id, x: event.clientX, y: event.clientY });
      });
    </script>
    <button id="inner" style="position:fixed;left:10px;top:10px;width:100px;height:30px">Inner button</button>
  </body>
</html>`;
    case "/dom/named-frame-host":
      return `<!DOCTYPE html>
<html>
  <head><title>Named Frame Host</title></head>
  <body style="margin:0">
    <iframe name="child" src="/dom/frame-one" style="position:fixed;left:20px;top:20px;width:400px;height:200px;border:0"></iframe>
  </body>
</html>`;
    case "/dom/frame-one":
      return `<!DOCTYPE html>
<html>
  <body style="margin:0">
    <button id="fa" style="position:fixed;left:10px;top:10px;width:120px;height:30px">FrameOne</button>
  </body>
</html>`;
    case "/dom/frame-two":
      return `<!DOCTYPE html>
<html>
  <body style="margin:0">
    <script>
      window.frameClicks = [];
      document.addEventListener("click", (event) => window.frameClicks.push(event.target.id));
    </script>
    <button id="fb" style="position:fixed;left:10px;top:10px;width:120px;height:30px">FrameTwo</button>
  </body>
</html>`;
    case "/dom/frame-budget-host":
      return `<!DOCTYPE html>
<html>
  <body style="margin:0">
    <a id="hostlink" href="#host" style="position:fixed;left:10px;top:10px">Host link</a>
    <iframe src="/dom/many-links" style="position:fixed;left:20px;top:60px;width:1200px;height:600px;border:0"></iframe>
  </body>
</html>`;
    case "/dom/many-links":
      return manyLinksHtml(60, "m");
    default:
      return "";
  }
}

function handleDomRequest(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const html = domPageHtml(url.pathname);

  if (!html) {
    response.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
    });
    response.end("not found");
    return;
  }

  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

async function createDomServer(): Promise<DomServer> {
  const server = createServer(handleDomRequest);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Dom test server did not expose a TCP address");
  }

  const { port } = address as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

interface StubText {
  nodeType: 3;
  nodeValue: string;
}

interface StubElement {
  nodeType: 1;
  tagName: string;
  childNodes: Array<StubElement | StubText>;
  children: StubElement[];
  shadowRoot: { childNodes: Array<StubElement | StubText>; children: StubElement[] } | null;
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
  getClientRects: () => Array<{
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  }>;
}

function stubText(value: string): StubText {
  return { nodeType: 3, nodeValue: value };
}

function stubElement(
  tag: string,
  attrs: Record<string, string> = {},
  children: Array<StubElement | StubText> = [],
  shadowChildren?: Array<StubElement | StubText>
): StubElement {
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: children,
    children: children.filter((child): child is StubElement => child.nodeType === 1),
    shadowRoot: shadowChildren
      ? {
          childNodes: shadowChildren,
          children: shadowChildren.filter((child): child is StubElement => child.nodeType === 1),
        }
      : null,
    getAttribute: (name) =>
      Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name]! : null,
    hasAttribute: (name) => Object.prototype.hasOwnProperty.call(attrs, name),
    getClientRects: () => [{ left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 }],
  };
}

function createIsolatedRealm(root: StubElement): vm.Context {
  return vm.createContext({
    document: { body: root, documentElement: root },
    getComputedStyle: () => ({
      visibility: "visible",
      display: "block",
      pointerEvents: "auto",
      opacity: "1",
    }),
    innerWidth: 1280,
    innerHeight: 720,
  });
}

describe.sequential("QuickJS page.domCua toolset", () => {
  let browserRootDir = "";
  let manager: BrowserManager;
  let server: DomServer;
  let crossOriginServer: DomServer;

  beforeAll(async () => {
    await ensureSandboxClientBundle();

    browserRootDir = await mkdtemp(path.join(os.tmpdir(), "dev-browser-dom-cua-"));
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
    server = await createDomServer();
    crossOriginServer = await createDomServer();
  }, 180_000);

  afterAll(async () => {
    await manager.stopAll();
    await server.close();
    await crossOriginServer.close();
    await removeDirectoryWithRetries(browserRootDir);
  }, 180_000);

  describe.sequential("snapshots", () => {
    const browserName = "dom-cua-snapshots";
    let harness: JsonSandboxHarness;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("renders interactive elements as pseudo-HTML lines with node ids", async () => {
      const { snapshot } = await harness.runJson<{ snapshot: string }>(`
        const page = await browser.getPage("dom-cua-format");
        await page.setContent(${JSON.stringify(DOM_TEST_PAGE_HTML)}, { waitUntil: "load" });
        console.log(JSON.stringify({ snapshot: await page.domCua.getVisibleDom() }));
      `);

      expect(snapshot).toMatch(/<input node_id=\d+ placeholder="name here" type="text" \/>/);
      expect(snapshot).toMatch(/<button node_id=\d+>Submit<\/button>/);
      expect(snapshot).toMatch(/<a node_id=\d+ href="https:\/\/example\.com">Example link<\/a>/);
      expect(snapshot).toMatch(/<input node_id=\d+ type="checkbox"[^>]*checked="true"[^>]*\/>/);
      expect(snapshot).toMatch(/<div node_id=\d+ aria-label="Close" role="button">x<\/div>/);
      expect(snapshot).toMatch(/>Hello World</);
      expect(snapshot).toMatch(/>a &amp; b &lt; c</);

      const longLine = snapshot.split("\n").find((line) => line.includes("yyy"));
      expect(longLine).toMatch(/>y{160}</);
      expect(longLine).not.toMatch(/y{161}/);

      expect(snapshot).not.toContain("secret");
      expect(snapshot).not.toContain("Hidden A");
      expect(snapshot).not.toContain("Hidden B");
      expect(snapshot).not.toContain("Hidden C");
      expect(snapshot).not.toContain("Hidden D");
      expect(snapshot).not.toContain("Hidden E");
      expect(snapshot).not.toContain("Hidden F");
      expect(snapshot).not.toContain("plain text");
      expect(snapshot).not.toContain("Below the fold");
    }, 30_000);

    it("filters by viewport and includes elements after scrolling", async () => {
      const result = await harness.runJson<{ before: string; after: string }>(`
        const page = await browser.getPage("dom-cua-viewport");
        await page.setContent(${JSON.stringify(DOM_TEST_PAGE_HTML)}, { waitUntil: "load" });
        const before = await page.domCua.getVisibleDom();
        await page.evaluate(() => window.scrollTo(0, 2000));
        const after = await page.domCua.getVisibleDom();
        console.log(JSON.stringify({ before, after }));
      `);

      expect(result.before).toContain(">Submit<");
      expect(result.before).not.toContain("Below the fold");
      expect(result.after).toContain("Below the fold");
      expect(result.after).not.toContain(">Submit<");
    }, 30_000);

    it("keeps ids sticky across snapshots and assigns fresh ids to new elements", async () => {
      const result = await harness.runJson<{
        firstIds: number[];
        submitFirst: number;
        submitSecond: number;
        freshId: number;
      }>(`
        ${ID_HELPERS}
        const page = await browser.getPage("dom-cua-sticky");
        await page.setContent(${JSON.stringify(DOM_TEST_PAGE_HTML)}, { waitUntil: "load" });
        const first = await page.domCua.getVisibleDom();
        await page.evaluate(() => {
          document.body.insertAdjacentHTML(
            "beforeend",
            '<button id="fresh" style="position:absolute;left:600px;top:60px">Fresh</button>'
          );
        });
        const second = await page.domCua.getVisibleDom();
        console.log(JSON.stringify({
          firstIds: allIds(first),
          submitFirst: idFor(first, ">Submit<"),
          submitSecond: idFor(second, ">Submit<"),
          freshId: idFor(second, ">Fresh<"),
        }));
      `);

      expect(result.submitSecond).toBe(result.submitFirst);
      expect(result.firstIds).not.toContain(result.freshId);
      expect(result.freshId).toBeGreaterThan(Math.max(...result.firstIds));
    }, 30_000);

    it("appends a truncation marker when the element budget trips", async () => {
      const { snapshot } = await harness.runJson<{ snapshot: string }>(`
        const page = await browser.getPage("dom-cua-budget");
        await page.setContent(${JSON.stringify(BUDGET_PAGE_HTML)}, { waitUntil: "load" });
        console.log(JSON.stringify({ snapshot: await page.domCua.getVisibleDom() }));
      `);

      const lines = snapshot.split("\n");
      expect(lines.filter((line) => line.startsWith("<a ")).length).toBe(200);
      expect(snapshot).toContain("output truncated");
    }, 30_000);

    it("caps child frames at 50 elements with a truncation marker", async () => {
      const hostUrl = `${server.baseUrl}/dom/frame-budget-host`;
      const { snapshot } = await harness.runJson<{ snapshot: string }>(`
        const page = await browser.getPage("dom-cua-frame-budget");
        await page.goto(${JSON.stringify(hostUrl)}, { waitUntil: "load" });
        console.log(JSON.stringify({ snapshot: await page.domCua.getVisibleDom() }));
      `);

      const frameLines = snapshot.split("\n").filter((line) => line.includes('href="#m'));
      expect(frameLines.length).toBe(50);
      expect(snapshot).toContain(">Host link<");
      expect(snapshot).toContain("output truncated");
    }, 30_000);
  });

  describe.sequential("acting by node id", () => {
    const browserName = "dom-cua-act";
    let harness: JsonSandboxHarness;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("clicks the element that owns a node id", async () => {
      const firstUrl = `${server.baseUrl}/dom/first`;
      const result = await harness.runJson<{
        clicks: Array<{ target: string; x: number; y: number }>;
      }>(`
        ${ID_HELPERS}
        const page = await browser.getPage("dom-cua-act-click");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "load" });
        const snapshot = await page.domCua.getVisibleDom();
        await page.domCua.click({ nodeId: idFor(snapshot, ">Two<"), waitForNavigation: false });
        console.log(JSON.stringify({ clicks: await page.evaluate(() => window.clicks) }));
      `);

      expect(result.clicks).toEqual([{ target: "two", x: 80, y: 86 }]);
    }, 30_000);

    it("accepts a numeric-string nodeId as regexed from the snapshot text", async () => {
      const firstUrl = `${server.baseUrl}/dom/first`;
      const result = await harness.runJson<{
        clicks: Array<{ target: string; x: number; y: number }>;
      }>(`
        ${ID_HELPERS}
        const page = await browser.getPage("dom-cua-act-string-id");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "load" });
        const snapshot = await page.domCua.getVisibleDom();
        await page.domCua.click({ nodeId: String(idFor(snapshot, ">Two<")), waitForNavigation: false });
        console.log(JSON.stringify({ clicks: await page.evaluate(() => window.clicks) }));
      `);

      expect(result.clicks).toEqual([{ target: "two", x: 80, y: 86 }]);
    }, 30_000);

    it("clicks elements inside an iframe at frame-offset coordinates", async () => {
      const hostUrl = `${server.baseUrl}/dom/iframe-host`;
      const result = await harness.runJson<{
        snapshot: string;
        frameClicks: Array<{ target: string; x: number; y: number }>;
      }>(`
        ${ID_HELPERS}
        const page = await browser.getPage("dom-cua-act-iframe");
        await page.goto(${JSON.stringify(hostUrl)}, { waitUntil: "load" });
        const snapshot = await page.domCua.getVisibleDom();
        await page.domCua.click({ nodeId: idFor(snapshot, ">Inner button<"), waitForNavigation: false });
        const frame = page.frames().find((candidate) => candidate.url().includes("/dom/iframe-content"));
        const frameClicks = await frame.evaluate(() => window.frameClicks);
        console.log(JSON.stringify({ snapshot, frameClicks }));
      `);

      expect(result.snapshot).toContain(">Outer<");
      expect(result.snapshot).toContain(">Inner button<");
      expect(result.frameClicks).toEqual([{ target: "inner", x: 60, y: 25 }]);
    }, 30_000);

    it("doubleClick clicks twice at the node center", async () => {
      const firstUrl = `${server.baseUrl}/dom/first`;
      const result = await harness.runJson<{
        clicks: Array<{ target: string; x: number; y: number }>;
      }>(`
        ${ID_HELPERS}
        const page = await browser.getPage("dom-cua-act-double");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "load" });
        const snapshot = await page.domCua.getVisibleDom();
        await page.domCua.doubleClick({ nodeId: idFor(snapshot, ">One<") });
        console.log(JSON.stringify({ clicks: await page.evaluate(() => window.clicks) }));
      `);

      expect(result.clicks).toHaveLength(2);
      for (const click of result.clicks) {
        expect(click).toEqual({ target: "one", x: 80, y: 36 });
      }
    }, 30_000);

    it("scrolls at the node center when nodeId is given, viewport center otherwise", async () => {
      const result = await harness.runJson<{
        paneScroll: number;
        windowScrollAfterPane: number;
        windowScrollAfterViewport: number;
      }>(`
        ${ID_HELPERS}
        const page = await browser.getPage("dom-cua-act-scroll");
        await page.setContent(${JSON.stringify(SCROLL_ACT_PAGE_HTML)}, { waitUntil: "load" });
        const snapshot = await page.domCua.getVisibleDom();
        await page.domCua.scroll({ scrollY: 200, nodeId: idFor(snapshot, ">Pane link<") });
        await page.waitForFunction(() => document.getElementById("pane").scrollTop === 200, { timeout: 5000 });
        const paneScroll = await page.evaluate(() => document.getElementById("pane").scrollTop);
        const windowScrollAfterPane = await page.evaluate(() => window.scrollY);
        await page.domCua.scroll({ scrollY: 300 });
        await page.waitForFunction(() => window.scrollY === 300, { timeout: 5000 });
        const windowScrollAfterViewport = await page.evaluate(() => window.scrollY);
        console.log(JSON.stringify({ paneScroll, windowScrollAfterPane, windowScrollAfterViewport }));
      `);

      expect(result.paneScroll).toBe(200);
      expect(result.windowScrollAfterPane).toBe(0);
      expect(result.windowScrollAfterViewport).toBe(300);
    }, 30_000);

    it("types into the element focused by a click by id", async () => {
      const result = await harness.runJson<{ value: string }>(`
        ${ID_HELPERS}
        const page = await browser.getPage("dom-cua-act-type");
        await page.setContent(${JSON.stringify(TYPE_ACT_PAGE_HTML)}, { waitUntil: "load" });
        const snapshot = await page.domCua.getVisibleDom();
        await page.domCua.click({ nodeId: idFor(snapshot, "<input"), waitForNavigation: false });
        await page.domCua.type({ text: "hello dom" });
        console.log(JSON.stringify({ value: await page.inputValue("#field") }));
      `);

      expect(result.value).toBe("hello dom");
    }, 30_000);

    it("fails fast with a clean error when the element is hidden", async () => {
      const result = await harness.runJson<{
        error: string | null;
        elapsed: number;
        clicks: string[];
      }>(`
        ${ID_HELPERS}
        const page = await browser.getPage("dom-cua-act-hidden");
        await page.setContent(${JSON.stringify(HIDDEN_ACT_PAGE_HTML)}, { waitUntil: "load" });
        const snapshot = await page.domCua.getVisibleDom();
        const nodeId = idFor(snapshot, ">Target<");
        await page.evaluate(() => {
          document.getElementById("target").style.display = "none";
        });
        const start = Date.now();
        let error = null;
        try {
          await page.domCua.click({ nodeId });
        } catch (caught) {
          error = String((caught && caught.message) || caught);
        }
        const elapsed = Date.now() - start;
        console.log(JSON.stringify({ error, elapsed, clicks: await page.evaluate(() => window.clicks) }));
      `);

      expect(result.error).toContain("stale or missing — re-run getVisibleDom()");
      expect(result.elapsed).toBeLessThan(10_000);
      expect(result.clicks).toEqual([]);
    }, 30_000);
  });

  describe.sequential("navigation and staleness", () => {
    const browserName = "dom-cua-stale";
    let harness: JsonSandboxHarness;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("fails fast on ids from before a reload", async () => {
      const firstUrl = `${server.baseUrl}/dom/first`;
      const result = await harness.runJson<{ error: string | null; elapsed: number }>(`
        ${ID_HELPERS}
        const page = await browser.getPage("dom-cua-reload");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "load" });
        const snapshot = await page.domCua.getVisibleDom();
        const nodeId = idFor(snapshot, ">Three<");
        await page.reload({ waitUntil: "load" });
        const start = Date.now();
        let error = null;
        try {
          await page.domCua.click({ nodeId });
        } catch (caught) {
          error = String((caught && caught.message) || caught);
        }
        console.log(JSON.stringify({ error, elapsed: Date.now() - start }));
      `);

      expect(result.error).toContain("stale or missing — re-run getVisibleDom()");
      expect(result.elapsed).toBeLessThan(3000);
    }, 30_000);

    it("never reuses pre-navigation ids: acting on one errors instead of clicking", async () => {
      const firstUrl = `${server.baseUrl}/dom/first`;
      const secondUrl = `${server.baseUrl}/dom/second`;
      const result = await harness.runJson<{
        preNavIds: number[];
        postNavIds: number[];
        error: string | null;
        clicks: Array<{ target: string }>;
      }>(`
        ${ID_HELPERS}
        const page = await browser.getPage("dom-cua-id-reuse");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "load" });
        const preNavIds = allIds(await page.domCua.getVisibleDom());
        await page.goto(${JSON.stringify(secondUrl)}, { waitUntil: "load" });
        const postNavIds = allIds(await page.domCua.getVisibleDom());
        let error = null;
        try {
          await page.domCua.click({ nodeId: preNavIds[0] });
        } catch (caught) {
          error = String((caught && caught.message) || caught);
        }
        const clicks = await page.evaluate(() => window.clicks);
        console.log(JSON.stringify({ preNavIds, postNavIds, error, clicks }));
      `);

      expect(result.preNavIds).toHaveLength(3);
      expect(result.postNavIds).toHaveLength(5);
      expect(Math.min(...result.postNavIds)).toBeGreaterThan(Math.max(...result.preNavIds));
      expect(result.error).toContain("stale or missing — re-run getVisibleDom()");
      expect(result.clicks).toEqual([]);
    }, 30_000);

    it("never reuses pre-navigation ids across cross-origin navigations", async () => {
      const firstUrl = `${server.baseUrl}/dom/first`;
      const secondUrl = `${crossOriginServer.baseUrl}/dom/second`;
      const result = await harness.runJson<{
        preNavIds: number[];
        postNavIds: number[];
        error: string | null;
        clicks: Array<{ target: string }>;
      }>(`
        ${ID_HELPERS}
        const page = await browser.getPage("dom-cua-cross-origin");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "load" });
        const preNavIds = allIds(await page.domCua.getVisibleDom());
        await page.goto(${JSON.stringify(secondUrl)}, { waitUntil: "load" });
        const postNavIds = allIds(await page.domCua.getVisibleDom());
        let error = null;
        try {
          await page.domCua.click({ nodeId: preNavIds[0] });
        } catch (caught) {
          error = String((caught && caught.message) || caught);
        }
        const clicks = await page.evaluate(() => window.clicks);
        console.log(JSON.stringify({ preNavIds, postNavIds, error, clicks }));
      `);

      expect(result.preNavIds).toHaveLength(3);
      expect(result.postNavIds).toHaveLength(5);
      expect(result.postNavIds.filter((id) => result.preNavIds.includes(id))).toEqual([]);
      expect(result.error).toContain("stale or missing — re-run getVisibleDom()");
      expect(result.clicks).toEqual([]);
    }, 30_000);

    it("assigns fresh ids after a child-frame navigation and stales the old ones", async () => {
      const hostUrl = `${server.baseUrl}/dom/named-frame-host`;
      const frameTwoUrl = `${server.baseUrl}/dom/frame-two`;
      const result = await harness.runJson<{
        oldId: number;
        newId: number;
        error: string | null;
        frameClicks: string[];
      }>(`
        ${ID_HELPERS}
        const page = await browser.getPage("dom-cua-frame-nav");
        await page.goto(${JSON.stringify(hostUrl)}, { waitUntil: "load" });
        const first = await page.domCua.getVisibleDom();
        const oldId = idFor(first, ">FrameOne<");
        const frame = page.frames().find((candidate) => candidate.name() === "child");
        await frame.goto(${JSON.stringify(frameTwoUrl)}, { waitUntil: "load" });
        const second = await page.domCua.getVisibleDom();
        const newId = idFor(second, ">FrameTwo<");
        let error = null;
        try {
          await page.domCua.click({ nodeId: oldId, waitForNavigation: false });
        } catch (caught) {
          error = String((caught && caught.message) || caught);
        }
        const frameClicks = await frame.evaluate(() => window.frameClicks);
        console.log(JSON.stringify({ oldId, newId, error, frameClicks }));
      `);

      expect(result.newId).toBeGreaterThan(result.oldId);
      expect(result.error).toContain("stale or missing — re-run getVisibleDom()");
      expect(result.frameClicks).toEqual([]);
    }, 30_000);
  });

  describe.sequential("cross-invocation", () => {
    const browserName = "dom-cua-cross";

    beforeAll(async () => {
      await manager.ensureBrowser(browserName, {
        headless: true,
      });
    }, 180_000);

    afterAll(async () => {
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("acts on ids from a snapshot taken in a previous invocation", async () => {
      const firstUrl = `${server.baseUrl}/dom/first`;

      const snapshotOutput = createOutput();
      await runScript(
        `
        ${ID_HELPERS}
        const page = await browser.getPage("dom-cua-cross-page");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "load" });
        const snapshot = await page.domCua.getVisibleDom();
        console.log(JSON.stringify({ nodeId: idFor(snapshot, ">Two<") }));
        `,
        manager,
        browserName,
        snapshotOutput.sink
      );
      expect(snapshotOutput.stderr).toEqual([]);
      const { nodeId } = parseLastJsonLine<{ nodeId: number }>(snapshotOutput);
      expect(nodeId).toBeGreaterThan(0);

      const clickOutput = createOutput();
      await runScript(
        `
        const page = await browser.getPage("dom-cua-cross-page");
        await page.domCua.click({ nodeId: ${nodeId}, waitForNavigation: false });
        console.log(JSON.stringify({ clicks: await page.evaluate(() => window.clicks) }));
        `,
        manager,
        browserName,
        clickOutput.sink
      );
      expect(clickOutput.stderr).toEqual([]);
      const { clicks } = parseLastJsonLine<{
        clicks: Array<{ target: string; x: number; y: number }>;
      }>(clickOutput);
      expect(clicks).toEqual([{ target: "two", x: 80, y: 86 }]);
    }, 60_000);
  });

  describe("walker self-containment", () => {
    it("runs the serialized walker in an isolated realm against a DOM stub", () => {
      const input = stubElement("input", { type: "text", placeholder: "name here" });
      const button = stubElement("button", {}, [stubText("Submit")]);
      const link = stubElement("a", { href: "https://example.com" }, [stubText("Example link")]);
      const shadowed = stubElement("button", {}, [], [stubText("Shadow label")]);
      const plain = stubElement("div", {}, [stubText("ignore me")]);
      const root = stubElement("body", {}, [input, button, link, shadowed, plain]);
      const realm = createIsolatedRealm(root);

      const walkerInRealm = vm.runInContext(`(${String(domCuaWalker)})`, realm);
      const result = walkerInRealm({ maxElements: 50 });

      expect(result.blocked).toBe(false);
      expect(result.truncated).toBe(false);
      expect(typeof result.docToken).toBe("string");
      expect(result.entries.map((entry: { line: string }) => entry.line)).toEqual([
        '<input node_id=1 placeholder="name here" type="text" />',
        "<button node_id=2>Submit</button>",
        '<a node_id=3 href="https://example.com">Example link</a>',
        "<button node_id=4>Shadow label</button>",
      ]);

      const again = walkerInRealm({ maxElements: 50 });
      expect(again.entries.map((entry: { ref: number }) => entry.ref)).toEqual([1, 2, 3, 4]);
      expect(again.docToken).toBe(result.docToken);

      const capped = walkerInRealm({ maxElements: 2 });
      expect(capped.truncated).toBe(true);
      expect(capped.entries).toHaveLength(2);
    });

    it("runs the serialized register function in an isolated realm", () => {
      const realm = createIsolatedRealm(stubElement("body"));
      const registerInRealm = vm.runInContext(`(${String(domCuaRegister)})`, realm);

      const first = registerInRealm({
        frames: [{ key: "main", docToken: "doc-1", refs: [1, 2, 3] }],
      });
      expect(first.blocked).toBe(false);
      expect(first.ids[0]).toHaveLength(3);
      expect(first.ids[0][0]).toBeGreaterThanOrEqual(1_000_000);

      const second = registerInRealm({
        frames: [{ key: "main", docToken: "doc-1", refs: [2, 3, 9] }],
      });
      expect(second.blocked).toBe(false);
      expect(second.ids[0][0]).toBe(first.ids[0][1]);
      expect(second.ids[0][1]).toBe(first.ids[0][2]);
      expect(second.ids[0][2]).toBeGreaterThan(first.ids[0][2]);

      const replaced = registerInRealm({
        frames: [{ key: "main", docToken: "doc-2", refs: [1, 2, 3] }],
      });
      expect(replaced.blocked).toBe(false);
      for (const id of replaced.ids[0]) {
        expect(id).toBeGreaterThan(second.ids[0][2]);
      }
    });

    it("starts at a high base when sessionStorage works but holds no counter", () => {
      const storage = new Map<string, string>();
      const realm = vm.createContext({
        sessionStorage: {
          getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
          setItem: (key: string, value: string) => {
            storage.set(key, String(value));
          },
        },
      });
      const registerInRealm = vm.runInContext(`(${String(domCuaRegister)})`, realm);

      const result = registerInRealm({
        frames: [{ key: "main", docToken: "doc-1", refs: [1, 2] }],
      });
      expect(result.blocked).toBe(false);
      expect(Math.min(...result.ids[0])).toBeGreaterThanOrEqual(1_000_000);
      expect(Number(storage.get("__devBrowserDomCuaNextPublicId"))).toBeGreaterThan(
        Math.max(...result.ids[0])
      );
    });
  });
});
