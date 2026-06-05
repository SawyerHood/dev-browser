import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "../../browser-manager.js";
import { DEV_BROWSER_TMP_DIR } from "../../temp-files.js";
import { removeDirectoryWithRetries } from "../../test-cleanup.js";
import { QuickJSSandbox } from "../quickjs-sandbox.js";
import { ensureSandboxClientBundle } from "./bundle-test-helpers.js";

const SANDBOX_TIMEOUT_MS = 60_000;

const CUA_TEST_PAGE_HTML = String.raw`<!DOCTYPE html>
<html>
  <head>
    <title>CUA Test Page</title>
    <style>
      body {
        margin: 0;
      }

      #target {
        position: absolute;
        left: 300px;
        top: 200px;
        width: 100px;
        height: 100px;
        background: #ff0000;
      }

      #field {
        position: absolute;
        left: 20px;
        top: 20px;
        width: 200px;
      }

      #spacer {
        width: 3000px;
        height: 3000px;
      }
    </style>
  </head>
  <body>
    <div id="target"></div>
    <input id="field" type="text" />
    <div id="spacer"></div>
    <script>
      window.clicks = [];
      window.mouseEvents = [];
      window.keyEvents = [];

      document.addEventListener("click", (event) => {
        window.clicks.push({
          x: event.clientX,
          y: event.clientY,
          button: event.button,
          detail: event.detail,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
        });
      });

      for (const type of ["mousedown", "mousemove", "mouseup"]) {
        document.addEventListener(type, (event) => {
          window.mouseEvents.push({
            type,
            x: event.clientX,
            y: event.clientY,
            button: event.button,
          });
        });
      }

      document.addEventListener("keydown", (event) => {
        window.keyEvents.push({
          key: event.key,
          code: event.code,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
        });
      });

      document.addEventListener("contextmenu", (event) => event.preventDefault());
    </script>
  </body>
</html>`;

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
}

interface JsonSandboxHarness {
  dispose: () => Promise<void>;
  runJson: <T>(script: string) => Promise<T>;
}

interface NavigationServer {
  baseUrl: string;
  close: () => Promise<void>;
}

interface RecordedClick {
  x: number;
  y: number;
  button: number;
  detail: number;
  shiftKey: boolean;
  altKey: boolean;
}

interface RecordedMouseEvent {
  type: string;
  x: number;
  y: number;
  button: number;
}

interface RecordedKeyEvent {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

interface ScreenshotResult {
  path: string;
  width: number;
  height: number;
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

function outputLines(output: CapturedOutput): string[] {
  return output.stdout.map((line) => line.trim()).filter((line) => line.length > 0);
}

function parseLastJsonLine<T>(output: CapturedOutput): T {
  const lines = outputLines(output);
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines.at(-1)!) as T;
}

function withCuaPage(pageName: string, body: string): string {
  return `
    const page = await browser.getPage(${JSON.stringify(pageName)});
    await page.setContent(${JSON.stringify(CUA_TEST_PAGE_HTML)}, { waitUntil: "load" });
    ${body}
  `;
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

function readJpegDimensions(data: Buffer): { width: number; height: number } {
  expect(data[0]).toBe(0xff);
  expect(data[1]).toBe(0xd8);
  expect(data[2]).toBe(0xff);

  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) {
      throw new Error("Invalid JPEG segment");
    }
    const marker = data[offset + 1];
    if (marker === undefined) {
      break;
    }
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: data.readUInt16BE(offset + 5),
        width: data.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + data.readUInt16BE(offset + 2);
  }

  throw new Error("No JPEG SOF marker found");
}

function navigationPageHtml(pathname: string): string {
  switch (pathname) {
    case "/cua/first":
      return `<!DOCTYPE html>
<html>
  <head><title>First Page</title></head>
  <body>
    <button id="nav" style="position:fixed;left:20px;top:20px;width:120px;height:40px" onclick="location.href='/cua/second'">Go</button>
  </body>
</html>`;
    case "/cua/second":
      return `<!DOCTYPE html>
<html>
  <head><title>Second Page</title></head>
  <body><h1>Second</h1></body>
</html>`;
    case "/cua/iframe-host":
      return `<!DOCTYPE html>
<html>
  <head><title>Iframe Host</title></head>
  <body>
    <button id="swap" style="position:fixed;left:20px;top:20px;width:120px;height:40px" onclick="document.getElementById('child').src='/cua/frame-b'">Swap</button>
    <iframe id="child" src="/cua/frame-a" style="position:fixed;left:20px;top:80px;width:300px;height:150px"></iframe>
  </body>
</html>`;
    case "/cua/frame-a":
      return `<!DOCTYPE html>
<html>
  <head><title>Frame A</title></head>
  <body>frame a</body>
</html>`;
    case "/cua/frame-b":
      return `<!DOCTYPE html>
<html>
  <head><title>Frame B</title></head>
  <body>frame b</body>
</html>`;
    default:
      return "";
  }
}

function handleNavigationRequest(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const html = navigationPageHtml(url.pathname);

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

async function createNavigationServer(): Promise<NavigationServer> {
  const server = createServer(handleNavigationRequest);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Navigation test server did not expose a TCP address");
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

describe.sequential("QuickJS page.cua toolset", () => {
  let browserRootDir = "";
  let manager: BrowserManager;
  const screenshotCleanup = new Set<string>();

  beforeAll(async () => {
    await ensureSandboxClientBundle();

    browserRootDir = await mkdtemp(path.join(os.tmpdir(), "dev-browser-cua-"));
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
  }, 180_000);

  afterAll(async () => {
    await manager.stopAll();
    await removeDirectoryWithRetries(browserRootDir);
    for (const filePath of screenshotCleanup) {
      await rm(filePath, {
        force: true,
      });
    }
  }, 180_000);

  describe.sequential("pointer and keyboard actions", () => {
    const browserName = "cua-input";
    let harness: JsonSandboxHarness;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("clicks at exact coordinates with the left button by default", async () => {
      const result = await harness.runJson<{ clicks: RecordedClick[] }>(
        withCuaPage(
          "cua-click",
          `
          await page.cua.click({ x: 350, y: 250, waitForNavigation: false });
          console.log(JSON.stringify({ clicks: await page.evaluate(() => window.clicks) }));
        `
        )
      );

      expect(result.clicks).toEqual([
        {
          x: 350,
          y: 250,
          button: 0,
          detail: 1,
          shiftKey: false,
          altKey: false,
        },
      ]);
    }, 15_000);

    it("supports middle and right buttons and rejects unsupported buttons", async () => {
      const result = await harness.runJson<{
        downs: RecordedMouseEvent[];
        buttonError: string | null;
      }>(
        withCuaPage(
          "cua-buttons",
          `
          await page.cua.click({ x: 350, y: 250, button: "right", waitForNavigation: false });
          await page.cua.click({ x: 350, y: 250, button: "middle", waitForNavigation: false });
          const downs = await page.evaluate(() => {
            return window.mouseEvents.filter((event) => event.type === "mousedown");
          });
          let buttonError = null;
          try {
            await page.cua.click({ x: 350, y: 250, button: "back" });
          } catch (error) {
            buttonError = String((error && error.message) || error);
          }
          console.log(JSON.stringify({ downs, buttonError }));
        `
        )
      );

      expect(result.downs.map((event) => event.button)).toEqual([2, 1]);
      expect(result.buttonError).toContain('Unsupported mouse button "back"');
      expect(result.buttonError).toContain('"left", "middle", or "right"');
    }, 15_000);

    it("doubleClick clicks twice at the same point", async () => {
      const result = await harness.runJson<{ clicks: RecordedClick[] }>(
        withCuaPage(
          "cua-double-click",
          `
          await page.cua.doubleClick({ x: 350, y: 250 });
          console.log(JSON.stringify({ clicks: await page.evaluate(() => window.clicks) }));
        `
        )
      );

      expect(result.clicks).toHaveLength(2);
      expect(result.clicks.map((click) => click.detail)).toEqual([1, 2]);
      for (const click of result.clicks) {
        expect(click.x).toBe(350);
        expect(click.y).toBe(250);
      }
    }, 15_000);

    it("holds modifiers during clicks and releases them afterwards", async () => {
      const result = await harness.runJson<{ clicks: RecordedClick[] }>(
        withCuaPage(
          "cua-modifiers",
          `
          await page.cua.click({ x: 350, y: 250, modifiers: ["shift"], waitForNavigation: false });
          await page.cua.click({ x: 350, y: 250, waitForNavigation: false });
          console.log(JSON.stringify({ clicks: await page.evaluate(() => window.clicks) }));
        `
        )
      );

      expect(result.clicks).toHaveLength(2);
      expect(result.clicks[0]!.shiftKey).toBe(true);
      expect(result.clicks[1]!.shiftKey).toBe(false);
    }, 15_000);

    it("releases already-pressed modifiers when a later key in the sequence is invalid", async () => {
      const result = await harness.runJson<{
        clickError: string | null;
        keypressError: string | null;
        clicks: RecordedClick[];
        keyEvents: RecordedKeyEvent[];
      }>(
        withCuaPage(
          "cua-modifier-release",
          `
          let clickError = null;
          try {
            await page.cua.click({
              x: 350,
              y: 250,
              modifiers: ["shift", "bogus"],
              waitForNavigation: false,
            });
          } catch (error) {
            clickError = String((error && error.message) || error);
          }
          let keypressError = null;
          try {
            await page.cua.keypress({ keys: ["ctrl", "bogus", "c"] });
          } catch (error) {
            keypressError = String((error && error.message) || error);
          }
          await page.cua.click({ x: 350, y: 250, waitForNavigation: false });
          await page.evaluate(() => {
            window.keyEvents = [];
          });
          await page.cua.keypress({ keys: ["a"] });
          console.log(JSON.stringify({
            clickError,
            keypressError,
            clicks: await page.evaluate(() => window.clicks),
            keyEvents: await page.evaluate(() => window.keyEvents),
          }));
        `
        )
      );

      expect(result.clickError).toContain("bogus");
      expect(result.keypressError).toContain("bogus");
      expect(result.clicks).toHaveLength(1);
      expect(result.clicks[0]!.shiftKey).toBe(false);
      expect(result.keyEvents).toHaveLength(1);
      expect(result.keyEvents[0]!.shiftKey).toBe(false);
      expect(result.keyEvents[0]!.ctrlKey).toBe(false);
      expect(result.keyEvents[0]!.metaKey).toBe(false);
    }, 15_000);

    it("moves the pointer", async () => {
      const result = await harness.runJson<{ moves: RecordedMouseEvent[] }>(
        withCuaPage(
          "cua-move",
          `
          await page.cua.move({ x: 123, y: 217 });
          const moves = await page.evaluate(() => {
            return window.mouseEvents.filter((event) => event.type === "mousemove");
          });
          console.log(JSON.stringify({ moves }));
        `
        )
      );

      const lastMove = result.moves.at(-1);
      expect(lastMove).toMatchObject({ x: 123, y: 217 });
    }, 15_000);

    it("drags along a path with pressed moves", async () => {
      const result = await harness.runJson<{ events: RecordedMouseEvent[] }>(
        withCuaPage(
          "cua-drag",
          `
          await page.cua.drag({
            path: [
              { x: 310, y: 210 },
              { x: 360, y: 260 },
              { x: 390, y: 290 },
            ],
          });
          console.log(JSON.stringify({ events: await page.evaluate(() => window.mouseEvents) }));
        `
        )
      );

      const downs = result.events.filter((event) => event.type === "mousedown");
      const ups = result.events.filter((event) => event.type === "mouseup");
      expect(downs).toEqual([{ type: "mousedown", x: 310, y: 210, button: 0 }]);
      expect(ups).toEqual([{ type: "mouseup", x: 390, y: 290, button: 0 }]);

      const downIndex = result.events.findIndex((event) => event.type === "mousedown");
      const upIndex = result.events.findIndex((event) => event.type === "mouseup");
      expect(downIndex).toBeLessThan(upIndex);

      const pressedMoves = result.events
        .slice(downIndex + 1, upIndex)
        .filter((event) => event.type === "mousemove");
      expect(pressedMoves.length).toBeGreaterThan(2);
      expect(pressedMoves.some((event) => event.x === 360 && event.y === 260)).toBe(true);
      expect(pressedMoves.at(-1)).toMatchObject({ x: 390, y: 290 });
    }, 15_000);

    it("scrolls delta-direct on both axes", async () => {
      const result = await harness.runJson<{
        afterDown: { x: number; y: number };
        afterRight: { x: number; y: number };
        afterUp: { x: number; y: number };
      }>(
        withCuaPage(
          "cua-scroll",
          `
          const readScroll = () => page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
          await page.cua.scroll({ x: 400, y: 300, scrollX: 0, scrollY: 400 });
          await page.waitForFunction(() => window.scrollY === 400, { timeout: 5000 });
          const afterDown = await readScroll();
          await page.cua.scroll({ x: 400, y: 300, scrollX: 250, scrollY: 0 });
          await page.waitForFunction(() => window.scrollX === 250, { timeout: 5000 });
          const afterRight = await readScroll();
          await page.cua.scroll({ x: 400, y: 300, scrollX: 0, scrollY: -150 });
          await page.waitForFunction(() => window.scrollY === 250, { timeout: 5000 });
          const afterUp = await readScroll();
          console.log(JSON.stringify({ afterDown, afterRight, afterUp }));
        `
        )
      );

      expect(result.afterDown).toEqual({ x: 0, y: 400 });
      expect(result.afterRight).toEqual({ x: 250, y: 400 });
      expect(result.afterUp).toEqual({ x: 250, y: 250 });
    }, 15_000);

    it("normalizes key aliases in keypress", async () => {
      const result = await harness.runJson<Record<string, RecordedKeyEvent[]>>(
        withCuaPage(
          "cua-key-aliases",
          `
          const record = async (keys) => {
            await page.evaluate(() => {
              window.keyEvents = [];
            });
            await page.cua.keypress({ keys });
            return await page.evaluate(() => window.keyEvents);
          };
          console.log(JSON.stringify({
            esc: await record(["esc"]),
            left: await record(["left"]),
            pageup: await record(["pageup"]),
            del: await record(["del"]),
            ret: await record(["return"]),
            space: await record(["space"]),
          }));
        `
        )
      );

      expect(result.esc).toHaveLength(1);
      expect(result.esc![0]!.key).toBe("Escape");
      expect(result.left![0]!.key).toBe("ArrowLeft");
      expect(result.pageup![0]!.key).toBe("PageUp");
      expect(result.del![0]!.key).toBe("Delete");
      expect(result.ret![0]!.key).toBe("Enter");
      expect(result.space![0]!.code).toBe("Space");
    }, 15_000);

    it("applies chord rewrites: ctrl+a selects all, ctrl+y becomes redo", async () => {
      const result = await harness.runJson<{
        selection: { start: number; end: number };
        selectAllKeys: RecordedKeyEvent[];
        redoKeys: RecordedKeyEvent[];
      }>(
        withCuaPage(
          "cua-chords",
          `
          await page.fill("#field", "hello world");
          await page.focus("#field");
          await page.evaluate(() => {
            window.keyEvents = [];
          });
          await page.cua.keypress({ keys: ["ctrl", "a"] });
          const selection = await page.evaluate(() => {
            const field = document.getElementById("field");
            return { start: field.selectionStart, end: field.selectionEnd };
          });
          const selectAllKeys = await page.evaluate(() => window.keyEvents);
          await page.evaluate(() => {
            window.keyEvents = [];
          });
          await page.cua.keypress({ keys: ["ctrl", "y"] });
          const redoKeys = await page.evaluate(() => window.keyEvents);
          console.log(JSON.stringify({ selection, selectAllKeys, redoKeys }));
        `
        )
      );

      expect(result.selection).toEqual({ start: 0, end: 11 });
      const selectAllLast = result.selectAllKeys.at(-1)!;
      expect(selectAllLast.key.toLowerCase()).toBe("a");
      expect(selectAllLast.ctrlKey || selectAllLast.metaKey).toBe(true);

      expect(result.redoKeys).toHaveLength(3);
      const redoLast = result.redoKeys.at(-1)!;
      expect(redoLast.key.toLowerCase()).toBe("z");
      expect(redoLast.shiftKey).toBe(true);
      expect(redoLast.ctrlKey || redoLast.metaKey).toBe(true);
    }, 15_000);

    it("types text with real keystrokes", async () => {
      const result = await harness.runJson<{ value: string }>(
        withCuaPage(
          "cua-type",
          `
          await page.focus("#field");
          await page.cua.type({ text: "hello world" });
          console.log(JSON.stringify({ value: await page.inputValue("#field") }));
        `
        )
      );

      expect(result.value).toBe("hello world");
    }, 15_000);
  });

  describe.sequential("screenshots", () => {
    const browserName = "cua-screenshots";
    let harness: JsonSandboxHarness;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("returns path and css-pixel viewport dimensions", async () => {
      const result = await harness.runJson<{
        shot: ScreenshotResult;
        dims: [number, number];
      }>(
        withCuaPage(
          "cua-shot-viewport",
          `
          const shot = await page.cua.screenshot();
          const dims = await page.evaluate(() => [innerWidth, innerHeight]);
          console.log(JSON.stringify({ shot, dims }));
        `
        )
      );
      screenshotCleanup.add(result.shot.path);

      expect(path.isAbsolute(result.shot.path)).toBe(true);
      expect(result.shot.path.startsWith(`${path.resolve(DEV_BROWSER_TMP_DIR)}${path.sep}`)).toBe(
        true
      );
      expect(path.basename(result.shot.path)).toMatch(/^cua-page.*\.jpeg$/);
      expect(result.shot.width).toBe(result.dims[0]);
      expect(result.shot.height).toBe(result.dims[1]);

      expect((await stat(result.shot.path)).size).toBeGreaterThan(0);
      const data = await readFile(result.shot.path);
      expect(readJpegDimensions(data)).toEqual({
        width: result.shot.width,
        height: result.shot.height,
      });
    }, 15_000);

    it("pins clip coordinate semantics as viewport-relative", async () => {
      const result = await harness.runJson<{ shot: ScreenshotResult }>(
        withCuaPage(
          "cua-shot-clip",
          `
          await page.evaluate(() => window.scrollTo(0, 150));
          await page.waitForFunction(() => window.scrollY === 150, { timeout: 5000 });
          const shot = await page.cua.screenshot({
            name: "cua-clip-test",
            clip: { x: 300, y: 50, width: 100, height: 100 },
          });
          console.log(JSON.stringify({ shot }));
        `
        )
      );
      screenshotCleanup.add(result.shot.path);

      expect(path.basename(result.shot.path)).toBe("cua-clip-test.jpeg");
      expect(result.shot.width).toBe(100);
      expect(result.shot.height).toBe(100);

      const data = await readFile(result.shot.path);
      expect(readJpegDimensions(data)).toEqual({ width: 100, height: 100 });

      const decoded = await harness.runJson<{
        pixel: { width: number; height: number; r: number; g: number; b: number };
      }>(`
        const page = await browser.getPage("cua-shot-clip");
        const pixel = await page.evaluate(async (encoded) => {
          const image = new Image();
          image.src = "data:image/jpeg;base64," + encoded;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0);
          const data = context.getImageData(50, 50, 1, 1).data;
          return {
            width: image.naturalWidth,
            height: image.naturalHeight,
            r: data[0],
            g: data[1],
            b: data[2],
          };
        }, ${JSON.stringify(data.toString("base64"))});
        console.log(JSON.stringify({ pixel }));
      `);

      expect(decoded.pixel.width).toBe(100);
      expect(decoded.pixel.height).toBe(100);
      expect(decoded.pixel.r).toBeGreaterThan(200);
      expect(decoded.pixel.g).toBeLessThan(80);
      expect(decoded.pixel.b).toBeLessThan(80);
    }, 30_000);

    it("supports fullPage screenshots with document dimensions", async () => {
      const result = await harness.runJson<{
        shot: ScreenshotResult;
        docDims: [number, number];
        viewport: [number, number];
      }>(
        withCuaPage(
          "cua-shot-fullpage",
          `
          const shot = await page.cua.screenshot({ name: "cua-fullpage-test", fullPage: true });
          const docDims = await page.evaluate(() => [
            document.documentElement.scrollWidth,
            document.documentElement.scrollHeight,
          ]);
          const viewport = await page.evaluate(() => [innerWidth, innerHeight]);
          console.log(JSON.stringify({ shot, docDims, viewport }));
        `
        )
      );
      screenshotCleanup.add(result.shot.path);

      expect(path.basename(result.shot.path)).toBe("cua-fullpage-test.jpeg");
      expect(result.shot.width).toBe(result.docDims[0]);
      expect(result.shot.height).toBe(result.docDims[1]);
      expect(result.shot.height).toBeGreaterThan(result.viewport[1]);

      const data = await readFile(result.shot.path);
      expect(readJpegDimensions(data)).toEqual({
        width: result.shot.width,
        height: result.shot.height,
      });
    }, 30_000);

    it("downscales device-pixel screenshots back to css pixels", async () => {
      const result = await harness.runJson<{
        shot: ScreenshotResult;
        dims: [number, number];
      }>(
        withCuaPage(
          "cua-shot-retina",
          `
          const dims = await page.evaluate(() => [innerWidth, innerHeight]);
          const oversized = await page.screenshot({
            type: "jpeg",
            quality: 80,
            clip: { x: 0, y: 0, width: dims[0] * 2, height: dims[1] * 2 },
          });
          page.screenshot = async () => oversized;
          const shot = await page.cua.screenshot({ name: "cua-retina-test" });
          console.log(JSON.stringify({ shot, dims }));
        `
        )
      );
      screenshotCleanup.add(result.shot.path);

      expect(result.shot.width).toBe(result.dims[0]);
      expect(result.shot.height).toBe(result.dims[1]);

      const data = await readFile(result.shot.path);
      expect(readJpegDimensions(data)).toEqual({
        width: result.shot.width,
        height: result.shot.height,
      });
    }, 30_000);
  });

  describe.sequential("navigation waiting", () => {
    const browserName = "cua-navigation";
    let harness: JsonSandboxHarness;
    let navigationServer: NavigationServer;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
      navigationServer = await createNavigationServer();
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await navigationServer.close();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("waits for click-triggered navigation by default", async () => {
      const firstUrl = `${navigationServer.baseUrl}/cua/first`;
      const result = await harness.runJson<{ url: string; title: string }>(`
        const page = await browser.getPage("cua-nav-default");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "load" });
        const box = await page.locator("#nav").boundingBox();
        await page.cua.click({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
        console.log(JSON.stringify({ url: page.url(), title: await page.title() }));
      `);

      expect(result.url).toBe(`${navigationServer.baseUrl}/cua/second`);
      expect(result.title).toBe("Second Page");
    }, 30_000);

    it("skips the navigation wait with waitForNavigation: false", async () => {
      const firstUrl = `${navigationServer.baseUrl}/cua/first`;
      const result = await harness.runJson<{ elapsed: number; url: string }>(`
        const page = await browser.getPage("cua-nav-escape");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "load" });
        const box = await page.locator("#nav").boundingBox();
        const start = Date.now();
        await page.cua.click({
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
          waitForNavigation: false,
        });
        const elapsed = Date.now() - start;
        await page.waitForURL("**/cua/second");
        console.log(JSON.stringify({ elapsed, url: page.url() }));
      `);

      expect(result.elapsed).toBeLessThan(900);
      expect(result.url).toBe(`${navigationServer.baseUrl}/cua/second`);
    }, 30_000);

    it("ignores child-frame navigations via the main-frame predicate", async () => {
      const hostUrl = `${navigationServer.baseUrl}/cua/iframe-host`;
      const result = await harness.runJson<{
        elapsed: number;
        url: string;
        frameUrls: string[];
      }>(`
        const page = await browser.getPage("cua-nav-iframe");
        await page.goto(${JSON.stringify(hostUrl)}, { waitUntil: "load" });
        const box = await page.locator("#swap").boundingBox();
        const start = Date.now();
        await page.cua.click({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
        const elapsed = Date.now() - start;
        console.log(JSON.stringify({
          elapsed,
          url: page.url(),
          frameUrls: page.frames().map((frame) => frame.url()),
        }));
      `);

      expect(result.elapsed).toBeGreaterThanOrEqual(900);
      expect(result.elapsed).toBeLessThan(5000);
      expect(result.url).toBe(hostUrl);
      expect(result.frameUrls).toContain(`${navigationServer.baseUrl}/cua/frame-b`);
    }, 30_000);
  });
});
