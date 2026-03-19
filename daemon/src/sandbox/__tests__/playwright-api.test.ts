import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserManager } from "../../browser-manager.js";
import { QuickJSSandbox } from "../quickjs-sandbox.js";

const execFileAsync = promisify(execFile);
const daemonDir = new URL("../../../", import.meta.url);
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const SANDBOX_TIMEOUT_MS = 60_000;

const TEST_PAGE_HTML = String.raw`<!DOCTYPE html>
<html>
  <head>
    <title>Test Page</title>
    <style>
      body {
        margin: 0;
        font-family: sans-serif;
      }

      #mouse-target {
        position: absolute;
        left: 40px;
        top: 40px;
        width: 120px;
        height: 60px;
        background: #0ea5e9;
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      #spacer {
        height: 1400px;
      }
    </style>
  </head>
  <body>
    <h1>Hello World</h1>
    <p id="text" data-kind="primary"><strong>Some</strong> text</p>
    <div id="html-block"><span>Inner <strong>HTML</strong></span></div>
    <input id="name" type="text" placeholder="Name" />
    <input id="email" type="email" placeholder="Email" />
    <textarea id="bio"></textarea>
    <input id="agree" type="checkbox" />
    <select id="color">
      <option value="red">Red</option>
      <option value="blue">Blue</option>
      <option value="green">Green</option>
    </select>
    <button id="submit">Submit</button>
    <button id="disabled" disabled>Disabled</button>
    <button id="focus-target">Focus target</button>
    <div id="result"></div>
    <ul id="list">
      <li class="item">Item 1</li>
      <li class="item">Item 2</li>
      <li class="item">Item 3</li>
    </ul>
    <div class="card">
      <span class="label">Alpha</span>
      <span class="child">Child A</span>
    </div>
    <div class="card">
      <span class="label">Beta</span>
      <span class="child">Child B</span>
    </div>
    <div class="parent">
      <span class="child">Nested child</span>
    </div>
    <div id="wait-target" hidden>Loaded later</div>
    <div id="transient">Transient element</div>
    <div id="hidden" style="display:none">Hidden content</div>
    <a href="https://example.com" id="link">Example Link</a>
    <div id="mouse-target">Mouse Target</div>
    <div id="spacer"></div>
    <div id="footer">Footer content</div>
    <script>
      window.events = { inputCount: 0 };
      window.readyFlag = false;
      window.extraReady = false;

      const result = document.getElementById("result");
      const nameInput = document.getElementById("name");
      const emailInput = document.getElementById("email");
      const bioInput = document.getElementById("bio");
      const agreeInput = document.getElementById("agree");
      const colorSelect = document.getElementById("color");

      document.getElementById("submit").addEventListener("click", () => {
        result.textContent = "clicked:" + nameInput.value + ":" + colorSelect.value;
      });

      nameInput.addEventListener("input", () => {
        window.events.inputCount += 1;
      });

      nameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          result.textContent = "enter:" + nameInput.value;
        }
      });

      emailInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          result.textContent = "email-enter:" + emailInput.value;
        }
      });

      bioInput.addEventListener("keydown", (event) => {
        if (event.key === "Tab") {
          document.getElementById("focus-target").focus();
        }
      });

      agreeInput.addEventListener("change", () => {
        result.dataset.checked = String(agreeInput.checked);
      });

      colorSelect.addEventListener("change", () => {
        result.dataset.color = colorSelect.value;
      });

      document.getElementById("mouse-target").addEventListener("click", () => {
        result.dataset.mouse = "clicked";
      });

      setTimeout(() => {
        document.getElementById("wait-target").hidden = false;
        window.readyFlag = true;
      }, 50);

      setTimeout(() => {
        document.getElementById("transient").style.display = "none";
      }, 80);

      setTimeout(() => {
        window.extraReady = "ok";
      }, 120);
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

function withTestPage(pageName: string, body: string): string {
  return `
    const page = await browser.getPage(${JSON.stringify(pageName)});
    await page.setContent(${JSON.stringify(TEST_PAGE_HTML)}, { waitUntil: "load" });
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

function navigationPageHtml(title: string, route: string, nextPath?: string): string {
  const nextLink = nextPath
    ? `<a id="next-link" href="${nextPath}">Next</a>`
    : '<span id="next-link">No next link</span>';

  return `<!DOCTYPE html>
<html>
  <head>
    <title>${title}</title>
  </head>
  <body>
    <h1>${title}</h1>
    <div id="route">${route}</div>
    ${nextLink}
  </body>
</html>`;
}

function handleNavigationRequest(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  let html = "";

  switch (url.pathname) {
    case "/nav/first":
      html = navigationPageHtml("First Page", "/nav/first", "/nav/second");
      break;
    case "/nav/second":
      html = navigationPageHtml("Second Page", "/nav/second", "/nav/third");
      break;
    case "/nav/third":
      html = navigationPageHtml("Third Page", "/nav/third");
      break;
    default:
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

describe.sequential("QuickJS Playwright Page API coverage", () => {
  let browserRootDir = "";
  let manager: BrowserManager;

  beforeAll(async () => {
    await execFileAsync(pnpmCommand, ["run", "bundle:sandbox-client"], {
      cwd: daemonDir,
    });

    browserRootDir = await mkdtemp(path.join(os.tmpdir(), "dev-browser-playwright-api-"));
    manager = new BrowserManager(path.join(browserRootDir, "browsers"));
  }, 180_000);

  afterAll(async () => {
    await manager.stopAll();
    await rm(browserRootDir, {
      recursive: true,
      force: true,
    });
  }, 180_000);

  describe.sequential("navigation", () => {
    const browserName = "playwright-navigation";
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

    it("supports goto with waitUntil, url(), and waitForURL()", async () => {
      const firstUrl = `${navigationServer.baseUrl}/nav/first`;
      const result = await harness.runJson<{
        firstUrl: string;
        secondUrl: string;
        firstTitle: string;
        secondTitle: string;
      }>(`
        const page = await browser.getPage("navigation-goto");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "domcontentloaded" });
        const firstTitle = await page.title();
        const firstUrl = page.url();
        const secondNavigation = page.waitForURL("**/nav/second");
        await page.click("#next-link");
        await secondNavigation;
        console.log(JSON.stringify({
          firstUrl,
          secondUrl: page.url(),
          firstTitle,
          secondTitle: await page.title(),
        }));
      `);

      expect(result.firstUrl).toBe(firstUrl);
      expect(result.secondUrl).toBe(`${navigationServer.baseUrl}/nav/second`);
      expect(result.firstTitle).toBe("First Page");
      expect(result.secondTitle).toBe("Second Page");
    });

    it("supports goBack(), goForward(), and reload()", async () => {
      const firstUrl = `${navigationServer.baseUrl}/nav/first`;
      const secondUrl = `${navigationServer.baseUrl}/nav/second`;

      const result = await harness.runJson<{
        backUrl: string;
        backTitle: string;
        forwardUrl: string;
        reloadTitle: string;
      }>(`
        const page = await browser.getPage("navigation-history");
        await page.goto(${JSON.stringify(firstUrl)}, { waitUntil: "load" });
        await page.goto(${JSON.stringify(secondUrl)}, { waitUntil: "load" });
        await page.goBack({ waitUntil: "load" });
        const backUrl = page.url();
        const backTitle = await page.title();
        await page.goForward({ waitUntil: "load" });
        const forwardUrl = page.url();
        await page.evaluate(() => {
          document.title = "Mutated Title";
        });
        await page.reload({ waitUntil: "load" });
        console.log(JSON.stringify({
          backUrl,
          backTitle,
          forwardUrl,
          reloadTitle: await page.title(),
        }));
      `);

      expect(result.backUrl).toBe(firstUrl);
      expect(result.backTitle).toBe("First Page");
      expect(result.forwardUrl).toBe(secondUrl);
      expect(result.reloadTitle).toBe("Second Page");
    });
  });

  describe.sequential("content and evaluation", () => {
    const browserName = "playwright-content-evaluation";
    let harness: JsonSandboxHarness;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("reads page content through page methods", async () => {
      const result = await harness.runJson<{
        title: string;
        contentHasTitle: boolean;
        contentHasFooter: boolean;
        text: string | null;
        html: string;
        innerText: string;
        kind: string | null;
        href: string | null;
      }>(
        withTestPage(
          "content-reading",
          `
          const content = await page.content();
          console.log(JSON.stringify({
            title: await page.title(),
            contentHasTitle: content.includes("<title>Test Page</title>"),
            contentHasFooter: content.includes("Footer content"),
            text: await page.textContent("#text"),
            html: await page.innerHTML("#html-block"),
            innerText: await page.innerText("#text"),
            kind: await page.getAttribute("#text", "data-kind"),
            href: await page.getAttribute("#link", "href"),
          }));
        `
        )
      );

      expect(result.title).toBe("Test Page");
      expect(result.contentHasTitle).toBe(true);
      expect(result.contentHasFooter).toBe(true);
      expect(result.text).toBe("Some text");
      expect(result.html).toContain("<strong>HTML</strong>");
      expect(result.innerText).toBe("Some text");
      expect(result.kind).toBe("primary");
      expect(result.href).toBe("https://example.com");
    });

    it("supports evaluate(), evaluate(arg), $eval(), and $$eval()", async () => {
      const result = await harness.runJson<{
        pageTitle: string;
        sum: number;
        upperText: string;
        listItems: string[];
      }>(
        withTestPage(
          "evaluation-methods",
          `
          const pageTitle = await page.evaluate(() => document.title);
          const sum = await page.evaluate((values) => values.left + values.right, {
            left: 2,
            right: 3,
          });
          const upperText = await page.$eval("#text", (element) => {
            return (element.textContent ?? "").toUpperCase();
          });
          const listItems = await page.$$eval("#list li", (elements) => {
            return elements.map((element) => element.textContent ?? "");
          });
          console.log(JSON.stringify({
            pageTitle,
            sum,
            upperText,
            listItems,
          }));
        `
        )
      );

      expect(result.pageTitle).toBe("Test Page");
      expect(result.sum).toBe(5);
      expect(result.upperText).toBe("SOME TEXT");
      expect(result.listItems).toEqual(["Item 1", "Item 2", "Item 3"]);
    });
  });

  describe.sequential("form interaction and waiting", () => {
    const browserName = "playwright-form-waiting";
    let harness: JsonSandboxHarness;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("supports fill(), click(), type(), press(), check(), uncheck(), and selectOption()", async () => {
      const result = await harness.runJson<{
        bio: string;
        name: string;
        email: string;
        inputCount: number;
        enterResult: string | null;
        clickResult: string | null;
        checkedAfterCheck: boolean;
        checkedAfterUncheck: boolean;
        selectedValues: string[];
        selectedValue: string;
      }>(
        withTestPage(
          "form-interaction",
          `
          await page.fill("#bio", "QuickJS bio");
          await page.type("#name", "Ada");
          const name = await page.inputValue("#name");
          const inputCount = await page.evaluate(() => window.events.inputCount);
          await page.press("#name", "Enter");
          const enterResult = await page.textContent("#result");
          await page.type("#email", "ada@example.com");
          await page.check("#agree");
          const checkedAfterCheck = await page.isChecked("#agree");
          const selectedValues = await page.selectOption("#color", "blue");
          const selectedValue = await page.inputValue("#color");
          await page.click("#submit");
          const clickResult = await page.textContent("#result");
          await page.uncheck("#agree");
          const checkedAfterUncheck = await page.isChecked("#agree");
          console.log(JSON.stringify({
            bio: await page.inputValue("#bio"),
            name,
            email: await page.inputValue("#email"),
            inputCount,
            enterResult,
            clickResult,
            checkedAfterCheck,
            checkedAfterUncheck,
            selectedValues,
            selectedValue,
          }));
        `
        )
      );

      expect(result.bio).toBe("QuickJS bio");
      expect(result.name).toBe("Ada");
      expect(result.email).toBe("ada@example.com");
      expect(result.inputCount).toBe(3);
      expect(result.enterResult).toBe("enter:Ada");
      expect(result.clickResult).toBe("clicked:Ada:blue");
      expect(result.checkedAfterCheck).toBe(true);
      expect(result.checkedAfterUncheck).toBe(false);
      expect(result.selectedValues).toEqual(["blue"]);
      expect(result.selectedValue).toBe("blue");
    });

    it("supports waitForSelector(), waitForTimeout(), and waitForFunction()", async () => {
      const result = await harness.runJson<{
        timeoutElapsed: number;
        waitTargetText: string | null;
        transientHidden: boolean;
        readyValue: string;
      }>(
        withTestPage(
          "wait-methods",
          `
          const start = Date.now();
          await page.waitForTimeout(40);
          const timeoutElapsed = Date.now() - start;
          await page.waitForSelector("#wait-target");
          await page.waitForSelector("#transient", { state: "hidden" });
          const readyHandle = await page.waitForFunction(() => window.extraReady);
          const readyValue = await readyHandle.jsonValue();
          await readyHandle.dispose();
          console.log(JSON.stringify({
            timeoutElapsed,
            waitTargetText: await page.textContent("#wait-target"),
            transientHidden: await page.isHidden("#transient"),
            readyValue,
          }));
        `
        )
      );

      expect(result.timeoutElapsed).toBeGreaterThanOrEqual(20);
      expect(result.waitTargetText).toBe("Loaded later");
      expect(result.transientHidden).toBe(true);
      expect(result.readyValue).toBe("ok");
    });
  });

  describe.sequential("locators and multiple elements", () => {
    const browserName = "playwright-locators";
    let harness: JsonSandboxHarness;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("supports locator actions, text helpers, visibility, enabled state, and nth accessors", async () => {
      const result = await harness.runJson<{
        textContent: string | null;
        innerText: string;
        kind: string | null;
        visible: boolean;
        hiddenVisible: boolean;
        submitEnabled: boolean;
        disabledEnabled: boolean;
        count: number;
        first: string | null;
        last: string | null;
        second: string | null;
        clickResult: string | null;
      }>(
        withTestPage(
          "locator-basics",
          `
          await page.locator("#name").fill("Grace");
          await page.locator("#submit").click();
          console.log(JSON.stringify({
            textContent: await page.locator("#text").textContent(),
            innerText: await page.locator("#text").innerText(),
            kind: await page.locator("#text").getAttribute("data-kind"),
            visible: await page.locator("#text").isVisible(),
            hiddenVisible: await page.locator("#hidden").isVisible(),
            submitEnabled: await page.locator("#submit").isEnabled(),
            disabledEnabled: await page.locator("#disabled").isEnabled(),
            count: await page.locator("#list li").count(),
            first: await page.locator("#list li").first().textContent(),
            last: await page.locator("#list li").last().textContent(),
            second: await page.locator("#list li").nth(1).textContent(),
            clickResult: await page.locator("#result").textContent(),
          }));
        `
        )
      );

      expect(result.textContent).toBe("Some text");
      expect(result.innerText).toBe("Some text");
      expect(result.kind).toBe("primary");
      expect(result.visible).toBe(true);
      expect(result.hiddenVisible).toBe(false);
      expect(result.submitEnabled).toBe(true);
      expect(result.disabledEnabled).toBe(false);
      expect(result.count).toBe(3);
      expect(result.first).toBe("Item 1");
      expect(result.last).toBe("Item 3");
      expect(result.second).toBe("Item 2");
      expect(result.clickResult).toBe("clicked:Grace:red");
    });

    it("supports filter(), chained locators, locator.all(), and iterating multiple elements", async () => {
      const result = await harness.runJson<{
        betaLabel: string | null;
        betaChild: string | null;
        nestedChild: string | null;
        items: string[];
      }>(
        withTestPage(
          "locator-advanced",
          `
          const betaCard = page.locator(".card").filter({ hasText: "Beta" });
          const items = [];
          for (const item of await page.locator("#list li").all()) {
            items.push(await item.innerText());
          }
          console.log(JSON.stringify({
            betaLabel: await betaCard.locator(".label").textContent(),
            betaChild: await betaCard.locator(".child").textContent(),
            nestedChild: await page.locator(".parent").locator(".child").textContent(),
            items,
          }));
        `
        )
      );

      expect(result.betaLabel).toBe("Beta");
      expect(result.betaChild).toBe("Child B");
      expect(result.nestedChild).toBe("Nested child");
      expect(result.items).toEqual(["Item 1", "Item 2", "Item 3"]);
    });
  });

  describe.sequential("accessibility snapshots", () => {
    const browserName = "playwright-snapshots";
    let harness: JsonSandboxHarness;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("supports ariaSnapshot() and sandbox snapshot helpers", async () => {
      const result = await harness.runJson<{
        directSnapshot: string;
        browserSnapshot: string;
        globalSnapshot: string;
      }>(
        withTestPage(
          "snapshot-main",
          `
          console.log(JSON.stringify({
            directSnapshot: await page.locator("body").ariaSnapshot(),
            browserSnapshot: await browser.snapshot("snapshot-main"),
            globalSnapshot: await snapshot(),
          }));
        `
        )
      );

      expect(result.browserSnapshot).toBe(result.directSnapshot);
      expect(result.globalSnapshot).toBe(result.directSnapshot);
      expect(result.directSnapshot).toContain('heading "Hello World"');
      expect(result.directSnapshot).toContain('button "Submit"');
    });
  });

  describe.sequential("screenshots and input devices", () => {
    const browserName = "playwright-media-input";
    let harness: JsonSandboxHarness;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("supports screenshot() and screenshot({ fullPage: true })", async () => {
      const result = await harness.runJson<{
        screenshotLength: number;
        fullPageLength: number;
      }>(
        withTestPage(
          "screenshots",
          `
          const screenshot = await page.screenshot();
          const fullPage = await page.screenshot({ fullPage: true });
          console.log(JSON.stringify({
            screenshotLength: screenshot.length,
            fullPageLength: fullPage.length,
          }));
        `
        )
      );

      expect(result.screenshotLength).toBeGreaterThan(0);
      expect(result.fullPageLength).toBeGreaterThan(0);
    });

    it("supports page.keyboard and page.mouse", async () => {
      const result = await harness.runJson<{
        typedValue: string;
        enterResult: string | null;
        mouseResult: string | null;
      }>(
        withTestPage(
          "input-devices",
          `
          await page.click("#name");
          await page.keyboard.type("hello");
          await page.keyboard.press("Enter");
          const enterResult = await page.textContent("#result");
          await page.mouse.click(80, 80);
          console.log(JSON.stringify({
            typedValue: await page.inputValue("#name"),
            enterResult,
            mouseResult: await page.getAttribute("#result", "data-mouse"),
          }));
        `
        )
      );

      expect(result.typedValue).toBe("hello");
      expect(result.enterResult).toBe("enter:hello");
      expect(result.mouseResult).toBe("clicked");
    });
  });

  describe.sequential("events", () => {
    const browserName = "playwright-events";
    let harness: JsonSandboxHarness;

    beforeAll(async () => {
      harness = await createSandboxHarness(manager, browserName);
    }, 180_000);

    afterAll(async () => {
      await harness.dispose();
      await manager.stopBrowser(browserName);
    }, 180_000);

    it("supports page.on('console')", async () => {
      const result = await harness.runJson<{
        messages: Array<{ type: string; text: string }>;
      }>(
        withTestPage(
          "console-events",
          `
          const messages = [];
          page.on("console", (message) => {
            messages.push({
              type: message.type(),
              text: message.text(),
            });
          });
          await page.evaluate(() => {
            console.log("from-page", 123);
          });
          await page.waitForTimeout(50);
          console.log(JSON.stringify({ messages }));
        `
        )
      );

      expect(result.messages).toEqual([
        {
          type: "log",
          text: "from-page 123",
        },
      ]);
    });
  });
});
