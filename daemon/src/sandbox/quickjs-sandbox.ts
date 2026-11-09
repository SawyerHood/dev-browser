import { readFile } from "node:fs/promises";
import util from "node:util";

import type { Page } from "playwright";

import type { BrowserManager } from "../browser-manager.js";
import * as AgentManager from "../agent-manager.js";
import * as AuditManager from "../audit-manager.js";
import * as AuthFlowManager from "../auth-flow-manager.js";
import * as CloudflareManager from "../cloudflare-manager.js";
import * as CookieManager from "../cookie-manager.js";
import * as ErrorCollector from "../error-collector.js";
import * as FormManager from "../form-manager.js";
import * as FuzzingManager from "../fuzzing-manager.js";
import { NetworkManager } from "../network-manager.js";
import { generateTest } from "../recording-manager.js";
import { SecretRedactor } from "../redaction.js";
import * as SecurityManager from "../security-manager.js";
import * as SessionManager from "../session-manager.js";
import {
  ensureDevBrowserTempDir,
  readDevBrowserTempFile,
  writeDevBrowserTempFile,
} from "../temp-files.js";
import * as VisualDiffManager from "../visual-diff-manager.js";
import { HostBridge } from "./host-bridge.js";
import { QuickJSHost, type QuickJSConsoleLevel } from "./quickjs-host.js";

const DEFAULT_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
const WAIT_FOR_OBJECT_ATTEMPTS = 1_000;
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolve sandbox-client.js: next to the running script (production), or in dist/ (development)
function findBundlePath(): string {
  const candidates = [
    fileURLToPath(new URL("./sandbox-client.js", import.meta.url)),
    fileURLToPath(new URL("../../dist/sandbox-client.js", import.meta.url)),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Failed to find sandbox-client.js. Searched:\n${candidates.map((c) => `  - ${c}`).join("\n")}`
  );
}
const BUNDLE_PATH = findBundlePath();
const TRANSPORT_RECEIVE_GLOBAL = "__transport_receive";

let bundleCodePromise: Promise<string> | undefined;

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) =>
      typeof arg === "string"
        ? arg
        : util.inspect(arg, {
            colors: false,
            depth: 6,
            compact: 3,
            breakLength: Infinity,
          })
    )
    .join(" ");
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function getSandboxClientBundleCode(): Promise<string> {
  bundleCodePromise ??= readFile(BUNDLE_PATH, "utf8").catch((error: unknown) => {
    bundleCodePromise = undefined;
    const message =
      error instanceof Error ? error.message : "Sandbox client bundle could not be read";
    throw new Error(`Failed to load sandbox client bundle at ${BUNDLE_PATH}: ${message}`);
  });
  return bundleCodePromise;
}

function formatTimeoutDuration(timeoutMs: number): string {
  if (timeoutMs % 1_000 === 0) {
    return `${timeoutMs / 1_000}s`;
  }

  return `${timeoutMs}ms`;
}

function createScriptTimeoutError(timeoutMs: number): Error {
  const error = new Error(
    `Script timed out after ${formatTimeoutDuration(timeoutMs)} and was terminated.`
  );
  error.name = "ScriptTimeoutError";
  return error;
}

function createGuestScriptTimeoutErrorSource(timeoutMs: number): string {
  const message = JSON.stringify(createScriptTimeoutError(timeoutMs).message);
  return `(() => {
    const error = new Error(${message});
    error.name = "ScriptTimeoutError";
    return error;
  })()`;
}

function wrapScriptWithWallClockTimeout(script: string, timeoutMs?: number): string {
  if (timeoutMs === undefined) {
    return script;
  }

  return `
    (() => {
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(${createGuestScriptTimeoutErrorSource(timeoutMs)});
        }, ${timeoutMs});

        Promise.resolve()
          .then(() => (${script}))
          .then(resolve, reject)
          .finally(() => {
            clearTimeout(timeoutId);
          });
      });
    })()
  `;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }

  return value;
}

function toServerImpl<T>(clientObject: unknown, label: string): T {
  const connection = (clientObject as { _connection?: { toImpl?: (value: unknown) => unknown } })
    ._connection;
  const toImpl = connection?.toImpl;
  if (typeof toImpl !== "function") {
    throw new Error(`${label} does not expose a server implementation`);
  }

  const impl = toImpl(clientObject);
  if (!impl) {
    throw new Error(`${label} could not be mapped to a server implementation`);
  }

  return impl as T;
}

function extractGuid(page: Page): string {
  const guid = toServerImpl<{ guid?: unknown }>(page, "Playwright page").guid;
  if (typeof guid !== "string" || guid.length === 0) {
    throw new Error("Playwright page did not expose a guid");
  }

  return guid;
}

function decodeSandboxFilePayload(value: unknown, label: string): string | Uint8Array {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} must be an object`);
  }

  const encoding = "encoding" in value ? value.encoding : undefined;
  const data = "data" in value ? value.data : undefined;
  if ((encoding !== "utf8" && encoding !== "base64") || typeof data !== "string") {
    throw new TypeError(`${label} must include a valid encoding and string data`);
  }

  if (encoding === "utf8") {
    return data;
  }

  return Buffer.from(data, "base64");
}

interface QuickJSSandboxOptions {
  manager: BrowserManager;
  browserName: string;
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
  memoryLimitBytes?: number;
  timeoutMs?: number;
}

export class QuickJSSandbox {
  readonly #options: QuickJSSandboxOptions;
  readonly #anonymousPages = new Set<Page>();
  readonly #pendingHostOperations = new Set<Promise<void>>();
  readonly #transportInbox: string[] = [];
  readonly #redactor = new SecretRedactor();

  #asyncError?: Error;
  #host?: QuickJSHost;
  #hostBridge?: HostBridge;
  #networkManager?: NetworkManager;
  #flushPromise?: Promise<void>;
  #disposed = false;
  #initialized = false;

  constructor(options: QuickJSSandboxOptions) {
    this.#options = options;
  }

  async initialize(): Promise<void> {
    this.#assertAlive();
    if (this.#initialized) {
      return;
    }

    try {
      await ensureDevBrowserTempDir();

      this.#host = await QuickJSHost.create({
        memoryLimitBytes: this.#options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES,
        cpuTimeoutMs: this.#options.timeoutMs,
        hostFunctions: {
          getPage: (name) => this.#getPage(name),
          newPage: () => this.#newPage(),
          listPages: () => this.#options.manager.listPages(this.#options.browserName),
          closePage: (name) => this.#closePage(name),
          saveScreenshot: (name, data) => this.#writeTempFile(name, data),
          writeFile: (name, data) => this.#writeTempFile(name, data),
          readFile: (name) => this.#readTempFile(name),
          networkMock: (pattern, response) => this.#networkManager!.mock(pattern, response),
          networkClearMocks: (pattern) => this.#networkManager!.clearMocks(pattern),
          networkGetLog: (options) => this.#networkManager!.getLog(options) as unknown,
          networkClearLog: () => this.#networkManager!.clearLog(),
          networkIntercept: (pattern, mods) => this.#networkManager!.intercept(pattern, mods),
          networkClearIntercepts: (pattern) => this.#networkManager!.clearIntercepts(pattern),
          networkExportHar: () => this.#networkManager!.exportHar(),
          networkImportHar: (har) => { this.#networkManager!.importHar(har); },
          cookiesGet: (urls) => this.#cookiesGet(urls),
          cookiesSet: (cookies) => this.#cookiesSet(cookies),
          cookiesDelete: (filter) => this.#cookiesDelete(filter),
          auditSecurityHeaders: (pageName, options) =>
            this.#auditSecurityHeaders(pageName, options),
          securityReplay: (index, mods) => this.#securityReplay(index, mods),
          securityInspectCertificate: (pageName) => this.#securityInspectCertificate(pageName),
          securityDetectXSS: (pageName, options) => this.#securityDetectXSS(pageName, options),
          securityExtractCSRF: (pageName) => this.#securityExtractCSRF(pageName),
          securityReplayWithCSRF: (index, token, options) =>
            this.#securityReplayWithCSRF(index, token, options),
          securityDetectForms: (pageName) => this.#securityDetectForms(pageName),
          securityAutoFill: (pageName, credentials) =>
            this.#securityAutoFill(pageName, credentials),
          securitySubmitForm: (pageName, selector, data) =>
            this.#securitySubmitForm(pageName, selector, data),
          securityFuzz: (index, config) => this.#securityFuzz(index, config),
          securityPayloads: (setName) => FuzzingManager.getPayloads(setName),
          screenshotSaveBaseline: (name, data) => VisualDiffManager.saveBaseline(name, data),
          screenshotCompare: (name, data, options) =>
            VisualDiffManager.compareWithBaseline(name, data, options) as unknown,
          screenshotListBaselines: () => VisualDiffManager.listBaselines() as unknown,
          screenshotUpdateBaseline: (name, data) => VisualDiffManager.saveBaseline(name, data),
          recordingGenerateTest: (log, options) =>
            generateTest(log, options, this.#redactor) as unknown,
          secretsRegister: (name, value) => {
            this.#redactor.register(name, value);
          },
          sessionSave: (name, options) => this.#sessionSave(name, options),
          sessionRestore: (name, options) => this.#sessionRestore(name, options),
          sessionList: (options) => SessionManager.listSessions(options),
          sessionDelete: (name) => SessionManager.deleteSession(name),
          sessionInspect: (name) => SessionManager.inspectSession(name),
          errorsGet: (options) => ErrorCollector.getErrors(options as ErrorCollector.GetErrorsOptions) as unknown,
          errorsClear: (pageName) => { ErrorCollector.clearErrors(typeof pageName === "string" ? pageName : undefined); },
          errorsSummary: () => ErrorCollector.getSummary(),
          auditAccessibility: (pageName, options) => this.#auditPage("accessibility", pageName, options),
          auditPerformance: (pageName, options) => this.#auditPage("performance", pageName, options),
          auditFull: (pageName, options) => this.#auditPage("full", pageName, options),
          auditMixedContent: (pageName, options) =>
            this.#auditMixedContent(pageName, options),
          auditAuth: (pageName, options) => this.#auditAuth(pageName, options),
          agentSummarize: (pageName, options) => this.#agentSummarize(pageName, options),
          agentStableSelector: (pageName, target) =>
            this.#agentStableSelector(pageName, target),
          agentActIntent: (pageName, intent, options) =>
            this.#agentActIntent(pageName, intent, options),
          authFlowsDetect: () => this.#authFlowsDetect(),
          authFlowsReplay: (flowId, mutations) =>
            this.#authFlowsReplay(flowId, mutations),
          cloudflareDetect: (pageName) => this.#cloudflareDetect(pageName),
          cloudflareWaitForPass: (pageName, options) =>
            this.#cloudflareWaitForPass(pageName, options),
          cloudflareWaitForSolve: (pageName, options) =>
            this.#cloudflareWaitForSolve(pageName, options),
          cloudflareSaveClearance: (domain) => this.#cloudflareSaveClearance(domain),
          cloudflareRestoreClearance: (domain) => this.#cloudflareRestoreClearance(domain),
          cloudflareStealthArgs: (options) => this.#cloudflareStealthArgs(options),
        },
        onConsole: (level, args) => {
          this.#routeConsole(level, args);
        },
        onDrain: () => this.#drainAsyncOps(),
        onTransportSend: (message) => {
          this.#handleTransportSend(message);
        },
      });

      this.#host.executeScriptSync(
        `
          const __performanceOrigin = Date.now();
          const __base64Alphabet =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

          const __encodeBase64 = (bytes) => {
            let result = "";
            for (let index = 0; index < bytes.length; index += 3) {
              const chunk =
                (bytes[index] << 16) |
                ((bytes[index + 1] ?? 0) << 8) |
                (bytes[index + 2] ?? 0);
              result += __base64Alphabet[(chunk >> 18) & 63];
              result += __base64Alphabet[(chunk >> 12) & 63];
              result += index + 1 < bytes.length ? __base64Alphabet[(chunk >> 6) & 63] : "=";
              result += index + 2 < bytes.length ? __base64Alphabet[chunk & 63] : "=";
            }
            return result;
          };

          const __decodeBase64 = (base64) => {
            const normalized = String(base64).replace(/\\s+/g, "");
            const output = [];
            for (let index = 0; index < normalized.length; index += 4) {
              const a = __base64Alphabet.indexOf(normalized[index] ?? "A");
              const b = __base64Alphabet.indexOf(normalized[index + 1] ?? "A");
              const c =
                normalized[index + 2] === "="
                  ? 64
                  : __base64Alphabet.indexOf(normalized[index + 2] ?? "A");
              const d =
                normalized[index + 3] === "="
                  ? 64
                  : __base64Alphabet.indexOf(normalized[index + 3] ?? "A");
              const chunk = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);
              output.push((chunk >> 16) & 255);
              if (c !== 64) {
                output.push((chunk >> 8) & 255);
              }
              if (d !== 64) {
                output.push(chunk & 255);
              }
            }
            return new Uint8Array(output);
          };

          globalThis.URL ??= class URL {
            constructor(value, base) {
              this.href = base === undefined ? String(value) : String(base) + String(value);
            }

            toJSON() {
              return this.href;
            }

            toString() {
              return this.href;
            }
          };

          globalThis.Buffer ??= class Buffer extends Uint8Array {
            constructor(value, byteOffset, length) {
              if (typeof value === "number") {
                super(value);
                return;
              }
              if (value instanceof ArrayBuffer) {
                super(value, byteOffset, length);
                return;
              }
              if (ArrayBuffer.isView(value)) {
                super(value.buffer, value.byteOffset, value.byteLength);
                return;
              }
              super(value);
            }

            static from(value, encodingOrOffset, length) {
              if (typeof value === "string") {
                if (encodingOrOffset !== undefined && encodingOrOffset !== "base64") {
                  throw new Error("QuickJS Buffer only supports base64 string input");
                }
                return new Buffer(__decodeBase64(value));
              }
              if (value instanceof ArrayBuffer) {
                return new Buffer(value, encodingOrOffset, length);
              }
              if (ArrayBuffer.isView(value)) {
                return new Buffer(
                  value.buffer.slice(
                    value.byteOffset,
                    value.byteOffset + value.byteLength,
                  ),
                );
              }
              if (Array.isArray(value)) {
                return new Buffer(value);
              }
              throw new TypeError("Unsupported Buffer.from input");
            }

            toString(encoding) {
              if (encoding === undefined || encoding === "utf8") {
                return Array.from(this)
                  .map((value) => String.fromCharCode(value))
                  .join("");
              }
              if (encoding === "base64") {
                return __encodeBase64(this);
              }
              throw new Error("QuickJS Buffer only supports utf8 and base64 output");
            }
          };

          globalThis.performance ??= {
            now: () => Date.now() - __performanceOrigin,
            timeOrigin: __performanceOrigin,
          };
          globalThis.global = globalThis;
        `,
        {
          filename: "quickjs-runtime.js",
        }
      );

      const bundleCode = await getSandboxClientBundleCode();
      const bundleFactorySource = JSON.stringify(`${bundleCode}\nreturn __PlaywrightClient;`);
      this.#host.executeScriptSync(
        `
          globalThis.__createPlaywrightClient = () => {
            return new Function(${bundleFactorySource})();
          };
        `,
        {
          filename: "sandbox-client.js",
        }
      );

      const browserEntry = this.#options.manager.getBrowser(this.#options.browserName);
      if (!browserEntry) {
        throw new Error(
          `Browser "${this.#options.browserName}" not found. It should have been created before script execution.`
        );
      }
      this.#networkManager = new NetworkManager(browserEntry.context);
      this.#hostBridge = new HostBridge({
        sendToSandbox: (json) => {
          this.#transportInbox.push(json);
        },
        preLaunchedBrowser: toServerImpl(browserEntry.browser, "Playwright browser"),
        sharedBrowser: true,
        denyLaunch: true,
      });

      await this.#host.executeScript(
        `
          (() => {
            const hostCall = globalThis.__hostCall;
            const transportSend = globalThis.__transport_send;
            const createPlaywrightClient = globalThis.__createPlaywrightClient;

            if (typeof hostCall !== "function") {
              throw new Error("Sandbox bridge did not expose a host-call function");
            }
            if (typeof transportSend !== "function") {
              throw new Error("Sandbox bridge did not expose a transport sender");
            }
            if (typeof createPlaywrightClient !== "function") {
              throw new Error("Sandbox client bundle did not expose a Playwright client factory");
            }

            if (!delete globalThis.__hostCall) {
              globalThis.__hostCall = undefined;
            }
            if (!delete globalThis.__transport_send) {
              globalThis.__transport_send = undefined;
            }
            if (!delete globalThis.__createPlaywrightClient) {
              globalThis.__createPlaywrightClient = undefined;
            }

            const playwrightClient = createPlaywrightClient();
            const connection = new playwrightClient.Connection(playwrightClient.quickjsPlatform);
            connection.onmessage = (message) => {
              transportSend(JSON.stringify(message));
            };

            Object.defineProperty(globalThis, "${TRANSPORT_RECEIVE_GLOBAL}", {
              value: (json) => {
                connection.dispatch(JSON.parse(json));
              },
              configurable: false,
              enumerable: false,
              writable: false,
            });

            const waitForConnectionObject = async (guid, label) => {
              if (typeof guid !== "string" || guid.length === 0) {
                throw new Error(\`\${label} did not return a valid guid\`);
              }

              for (let attempt = 0; attempt < ${WAIT_FOR_OBJECT_ATTEMPTS}; attempt += 1) {
                const object = connection.getObjectWithKnownName(guid);
                if (object) {
                  return object;
                }
                await new Promise((resolve) => setTimeout(resolve, 0));
              }

              throw new Error(\`Timed out waiting for \${label} (\${guid}) in the sandbox\`);
            };

            const encodeHostFilePayload = (value) => {
              if (typeof value === "string") {
                return { encoding: "utf8", data: value };
              }
              if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
                return { encoding: "base64", data: Buffer.from(value).toString("base64") };
              }
              throw new TypeError(
                "File data must be a string, Buffer, Uint8Array, or ArrayBuffer",
              );
            };

            return (async () => {
              await connection.initializePlaywright();

              const browserApi = Object.create(null);
              Object.defineProperties(browserApi, {
                getPage: {
                  value: async (name) => {
                    const guid = await hostCall("getPage", JSON.stringify([name]));
                    return await waitForConnectionObject(guid, \`page "\${name}"\`);
                  },
                  enumerable: true,
                },
                newPage: {
                  value: async () => {
                    const guid = await hostCall("newPage", JSON.stringify([]));
                    return await waitForConnectionObject(guid, "anonymous page");
                  },
                  enumerable: true,
                },
                listPages: {
                  value: async () => {
                    return await hostCall("listPages", JSON.stringify([]));
                  },
                  enumerable: true,
                },
                closePage: {
                  value: async (name) => {
                    await hostCall("closePage", JSON.stringify([name]));
                  },
                  enumerable: true,
                },
              });
              Object.freeze(browserApi);

              Object.defineProperty(globalThis, "browser", {
                value: browserApi,
                configurable: false,
                enumerable: true,
                writable: false,
              });

              Object.defineProperties(globalThis, {
                saveScreenshot: {
                  value: async (buffer, name) => {
                    return await hostCall(
                      "saveScreenshot",
                      JSON.stringify([name, encodeHostFilePayload(buffer)]),
                    );
                  },
                  configurable: false,
                  enumerable: true,
                  writable: false,
                },
                writeFile: {
                  value: async (name, data) => {
                    return await hostCall(
                      "writeFile",
                      JSON.stringify([name, encodeHostFilePayload(data)]),
                    );
                  },
                  configurable: false,
                  enumerable: true,
                  writable: false,
                },
                readFile: {
                  value: async (name) => {
                    return await hostCall("readFile", JSON.stringify([name]));
                  },
                  configurable: false,
                  enumerable: true,
                  writable: false,
                },
              });

              // --- network API ---
              const networkApi = Object.create(null);
              Object.defineProperties(networkApi, {
                mock: {
                  value: async (pattern, response) => {
                    await hostCall("networkMock", JSON.stringify([pattern, response ?? {}]));
                  },
                  enumerable: true,
                },
                clearMocks: {
                  value: async (pattern) => {
                    await hostCall("networkClearMocks", JSON.stringify([pattern ?? null]));
                  },
                  enumerable: true,
                },
                getLog: {
                  value: async (options) => {
                    return await hostCall("networkGetLog", JSON.stringify([options ?? {}]));
                  },
                  enumerable: true,
                },
                clearLog: {
                  value: async () => {
                    await hostCall("networkClearLog", JSON.stringify([]));
                  },
                  enumerable: true,
                },
                intercept: {
                  value: async (pattern, modifications) => {
                    await hostCall("networkIntercept", JSON.stringify([pattern, modifications ?? {}]));
                  },
                  enumerable: true,
                },
                clearIntercepts: {
                  value: async (pattern) => {
                    await hostCall("networkClearIntercepts", JSON.stringify([pattern ?? null]));
                  },
                  enumerable: true,
                },
                exportHar: {
                  value: async () => {
                    return await hostCall("networkExportHar", JSON.stringify([]));
                  },
                  enumerable: true,
                },
                importHar: {
                  value: async (har) => {
                    await hostCall("networkImportHar", JSON.stringify([har]));
                  },
                  enumerable: true,
                },
              });
              Object.freeze(networkApi);
              Object.defineProperty(globalThis, "network", {
                value: networkApi,
                configurable: false,
                enumerable: true,
                writable: false,
              });

              // --- screenshot API ---
              const screenshotApi = Object.create(null);
              Object.defineProperties(screenshotApi, {
                baseline: {
                  value: async (page, name, options) => {
                    const opts = options || {};
                    let buf;
                    if (opts.element) {
                      buf = await page.locator(opts.element).screenshot();
                    } else {
                      const screenshotOpts = {};
                      if (opts.fullPage) screenshotOpts.fullPage = opts.fullPage;
                      if (opts.clip) screenshotOpts.clip = opts.clip;
                      buf = await page.screenshot(screenshotOpts);
                    }
                    return await hostCall(
                      "screenshotSaveBaseline",
                      JSON.stringify([name, encodeHostFilePayload(buf)]),
                    );
                  },
                  enumerable: true,
                },
                compare: {
                  value: async (page, name, options) => {
                    const opts = options || {};
                    let buf;
                    if (opts.element) {
                      buf = await page.locator(opts.element).screenshot();
                    } else {
                      const screenshotOpts = {};
                      if (opts.fullPage) screenshotOpts.fullPage = opts.fullPage;
                      if (opts.clip) screenshotOpts.clip = opts.clip;
                      buf = await page.screenshot(screenshotOpts);
                    }
                    return await hostCall(
                      "screenshotCompare",
                      JSON.stringify([name, encodeHostFilePayload(buf), opts]),
                    );
                  },
                  enumerable: true,
                },
                updateBaseline: {
                  value: async (page, name, options) => {
                    const opts = options || {};
                    let buf;
                    if (opts.element) {
                      buf = await page.locator(opts.element).screenshot();
                    } else {
                      const screenshotOpts = {};
                      if (opts.fullPage) screenshotOpts.fullPage = opts.fullPage;
                      if (opts.clip) screenshotOpts.clip = opts.clip;
                      buf = await page.screenshot(screenshotOpts);
                    }
                    return await hostCall(
                      "screenshotUpdateBaseline",
                      JSON.stringify([name, encodeHostFilePayload(buf)]),
                    );
                  },
                  enumerable: true,
                },
                listBaselines: {
                  value: async () => {
                    return await hostCall("screenshotListBaselines", JSON.stringify([]));
                  },
                  enumerable: true,
                },
              });
              Object.freeze(screenshotApi);
              Object.defineProperty(globalThis, "screenshot", {
                value: screenshotApi,
                configurable: false,
                enumerable: true,
                writable: false,
              });

              // --- recording API ---
              const recordingApi = (() => {
                let recordingLog = null;
                let recordingOptions = {};
                const recordingStart = Date.now();

                const LOCATOR_CHAIN_METHODS = new Set([
                  "getByRole", "getByLabel", "getByText", "getByTestId",
                  "getByPlaceholder", "getByAltText", "getByTitle",
                  "locator", "filter", "nth", "first", "last",
                ]);
                const LOCATOR_ACTION_METHODS = new Set([
                  "click", "fill", "type", "press", "check", "uncheck",
                  "selectOption", "hover", "focus", "blur", "tap", "dblclick",
                  "waitFor", "textContent", "innerText", "inputValue", "getAttribute",
                ]);
                const PAGE_ACTION_METHODS = new Set([
                  "goto", "click", "fill", "type", "press", "check", "uncheck",
                  "selectOption", "hover", "focus", "blur", "tap", "dblclick",
                  "reload", "goBack", "goForward", "waitForNavigation", "waitForURL",
                  "evaluate", "screenshot",
                ]);

                function serializeArg(arg) {
                  if (arg === null || arg === undefined) return arg;
                  if (typeof arg === "string" || typeof arg === "number" || typeof arg === "boolean") return arg;
                  if (typeof arg === "function") return "[function]";
                  if (typeof arg === "object") {
                    if (arg instanceof Uint8Array || arg instanceof ArrayBuffer) return "[binary]";
                    try {
                      const out = {};
                      for (const k of Object.keys(arg)) {
                        out[k] = serializeArg(arg[k]);
                      }
                      return out;
                    } catch { return String(arg); }
                  }
                  return String(arg);
                }

                function wrapLocator(locator, chain) {
                  return new Proxy(locator, {
                    get(target, prop) {
                      if (typeof prop !== "string") return target[prop];
                      const val = target[prop];
                      if (typeof val !== "function") return val;
                      if (LOCATOR_CHAIN_METHODS.has(prop)) {
                        return (...args) => {
                          const child = val.apply(target, args);
                          return wrapLocator(child, [...chain, { method: prop, args: args.map(serializeArg) }]);
                        };
                      }
                      if (LOCATOR_ACTION_METHODS.has(prop)) {
                        return async (...args) => {
                          if (recordingLog !== null) {
                            recordingLog.push({
                              kind: "locator-action",
                              chain,
                              action: prop,
                              args: args.map(serializeArg),
                              timestamp: Date.now() - recordingStart,
                            });
                          }
                          return val.apply(target, args);
                        };
                      }
                      return val.bind(target);
                    },
                  });
                }

                function wrapPage(page) {
                  return new Proxy(page, {
                    get(target, prop) {
                      if (typeof prop !== "string") return target[prop];
                      const val = target[prop];
                      if (typeof val !== "function") return val;
                      if (LOCATOR_CHAIN_METHODS.has(prop)) {
                        return (...args) => {
                          const locator = val.apply(target, args);
                          return wrapLocator(locator, [{ method: prop, args: args.map(serializeArg) }]);
                        };
                      }
                      if (PAGE_ACTION_METHODS.has(prop)) {
                        return async (...args) => {
                          if (recordingLog !== null) {
                            recordingLog.push({
                              kind: "page-action",
                              action: prop,
                              args: args.map(serializeArg),
                              timestamp: Date.now() - recordingStart,
                            });
                          }
                          return val.apply(target, args);
                        };
                      }
                      return val.bind(target);
                    },
                  });
                }

                return Object.freeze(Object.create(null, {
                  start: {
                    value: (options) => {
                      recordingLog = [];
                      recordingOptions = options || {};
                    },
                    enumerable: true,
                  },
                  wrap: {
                    value: (page) => {
                      if (recordingLog === null) {
                        throw new Error("Call recording.start() before recording.wrap()");
                      }
                      return wrapPage(page);
                    },
                    enumerable: true,
                  },
                  checkpoint: {
                    value: async (description, page) => {
                      if (recordingLog === null) {
                        throw new Error("Recording not started. Call recording.start() first.");
                      }
                      const url = page ? page.url() : "";
                      let title = "";
                      try { title = page ? await page.title() : ""; } catch {}
                      recordingLog.push({
                        kind: "checkpoint",
                        description: String(description || ""),
                        url,
                        title,
                        timestamp: Date.now() - recordingStart,
                      });
                    },
                    enumerable: true,
                  },
                  stop: {
                    value: async () => {
                      if (recordingLog === null) {
                        throw new Error("Recording not started. Call recording.start() first.");
                      }
                      const currentLog = recordingLog;
                      const currentOptions = recordingOptions;
                      recordingLog = null;
                      recordingOptions = {};
                      return await hostCall(
                        "recordingGenerateTest",
                        JSON.stringify([currentLog, currentOptions]),
                      );
                    },
                    enumerable: true,
                  },
                }));
              })();
              Object.defineProperty(globalThis, "recording", {
                value: recordingApi,
                configurable: false,
                enumerable: true,
                writable: false,
              });

              const secretsApi = Object.create(null);
              Object.defineProperties(secretsApi, {
                register: {
                  value: async (name, value) => {
                    await hostCall("secretsRegister", JSON.stringify([name, value]));
                  },
                  enumerable: true,
                },
              });
              Object.freeze(secretsApi);
              Object.defineProperty(globalThis, "secrets", {
                value: secretsApi,
                configurable: false,
                enumerable: true,
                writable: false,
              });

              // --- session API ---
              const sessionApi = Object.create(null);
              Object.defineProperties(sessionApi, {
                save: {
                  value: async (name, options) => {
                    return await hostCall("sessionSave", JSON.stringify([name, options ?? {}]));
                  },
                  enumerable: true,
                },
                restore: {
                  value: async (name, options) => {
                    return await hostCall("sessionRestore", JSON.stringify([name, options ?? {}]));
                  },
                  enumerable: true,
                },
                list: {
                  value: async (options) => {
                    return await hostCall("sessionList", JSON.stringify([options ?? {}]));
                  },
                  enumerable: true,
                },
                delete: {
                  value: async (name) => {
                    return await hostCall("sessionDelete", JSON.stringify([name]));
                  },
                  enumerable: true,
                },
                inspect: {
                  value: async (name) => {
                    return await hostCall("sessionInspect", JSON.stringify([name]));
                  },
                  enumerable: true,
                },
              });
              Object.freeze(sessionApi);
              Object.defineProperty(globalThis, "session", {
                value: sessionApi,
                configurable: false,
                enumerable: true,
                writable: false,
              });

              // --- errors API ---
              const errorsApi = Object.freeze(Object.create(null, {
                get: {
                  value: async (options) => {
                    return await hostCall("errorsGet", JSON.stringify([options ?? {}]));
                  },
                  enumerable: true,
                },
                clear: {
                  value: async (pageName) => {
                    await hostCall("errorsClear", JSON.stringify([pageName ?? null]));
                  },
                  enumerable: true,
                },
                summary: {
                  value: async () => {
                    return await hostCall("errorsSummary", JSON.stringify([]));
                  },
                  enumerable: true,
                },
              }));
              Object.defineProperty(globalThis, "errors", {
                value: errorsApi,
                configurable: false,
                enumerable: true,
                writable: false,
              });

              // --- audit API ---
              const auditApi = Object.freeze(Object.create(null, {
                accessibility: {
                  value: async (pageName, options) => {
                    return await hostCall("auditAccessibility", JSON.stringify([pageName, options ?? {}]));
                  },
                  enumerable: true,
                },
                performance: {
                  value: async (pageName, options) => {
                    return await hostCall("auditPerformance", JSON.stringify([pageName, options ?? {}]));
                  },
                  enumerable: true,
                },
                full: {
                  value: async (pageName, options) => {
                    return await hostCall("auditFull", JSON.stringify([pageName, options ?? {}]));
                  },
                  enumerable: true,
                },
                securityHeaders: {
                  value: async (pageName, options) => {
                    return await hostCall("auditSecurityHeaders", JSON.stringify([pageName, options ?? {}]));
                  },
                  enumerable: true,
                },
                mixedContent: {
                  value: async (pageName, options) => {
                    return await hostCall("auditMixedContent", JSON.stringify([pageName, options ?? {}]));
                  },
                  enumerable: true,
                },
                auth: {
                  value: async (pageName, options) => {
                    return await hostCall("auditAuth", JSON.stringify([pageName, options ?? {}]));
                  },
                  enumerable: true,
                },
              }));
              Object.defineProperty(globalThis, "audit", {
                value: auditApi,
                configurable: false,
                enumerable: true,
                writable: false,
              });

              // --- cookies API ---
              const cookiesApi = Object.freeze(Object.create(null, {
                get: {
                  value: async (urls) => {
                    return await hostCall("cookiesGet", JSON.stringify([urls ?? null]));
                  },
                  enumerable: true,
                },
                set: {
                  value: async (cookies) => {
                    await hostCall("cookiesSet", JSON.stringify([cookies]));
                  },
                  enumerable: true,
                },
                delete: {
                  value: async (filter) => {
                    await hostCall("cookiesDelete", JSON.stringify([filter ?? null]));
                  },
                  enumerable: true,
                },
              }));
              Object.defineProperty(globalThis, "cookies", {
                value: cookiesApi,
                configurable: false,
                enumerable: true,
                writable: false,
              });

              // --- security API (pentesting primitives) ---
              const securityApi = Object.freeze(Object.create(null, {
                replay: {
                  value: async (logIndex, modifications) => {
                    return await hostCall(
                      "securityReplay",
                      JSON.stringify([logIndex, modifications ?? {}]),
                    );
                  },
                  enumerable: true,
                },
                inspectCertificate: {
                  value: async (pageName) => {
                    return await hostCall("securityInspectCertificate", JSON.stringify([pageName]));
                  },
                  enumerable: true,
                },
                detectXSS: {
                  value: async (pageName, options) => {
                    return await hostCall(
                      "securityDetectXSS",
                      JSON.stringify([pageName, options ?? {}]),
                    );
                  },
                  enumerable: true,
                },
                extractCSRFTokens: {
                  value: async (pageName) => {
                    return await hostCall("securityExtractCSRF", JSON.stringify([pageName]));
                  },
                  enumerable: true,
                },
                replayWithCSRF: {
                  value: async (logIndex, token, options) => {
                    return await hostCall(
                      "securityReplayWithCSRF",
                      JSON.stringify([logIndex, token, options ?? {}]),
                    );
                  },
                  enumerable: true,
                },
                detectForms: {
                  value: async (pageName) => {
                    return await hostCall("securityDetectForms", JSON.stringify([pageName]));
                  },
                  enumerable: true,
                },
                autoFill: {
                  value: async (pageName, credentials) => {
                    await hostCall("securityAutoFill", JSON.stringify([pageName, credentials]));
                  },
                  enumerable: true,
                },
                submitForm: {
                  value: async (pageName, selector, data) => {
                    await hostCall(
                      "securitySubmitForm",
                      JSON.stringify([pageName, selector, data]),
                    );
                  },
                  enumerable: true,
                },
                fuzz: {
                  value: async (logIndex, config) => {
                    return await hostCall(
                      "securityFuzz",
                      JSON.stringify([logIndex, config ?? {}]),
                    );
                  },
                  enumerable: true,
                },
                payloads: {
                  value: async (setName) => {
                    return await hostCall("securityPayloads", JSON.stringify([setName]));
                  },
                  enumerable: true,
                },
                detectAuthFlows: {
                  value: async () => {
                    return await hostCall("authFlowsDetect", JSON.stringify([]));
                  },
                  enumerable: true,
                },
                replayAuthFlow: {
                  value: async (flowId, mutations) => {
                    return await hostCall(
                      "authFlowsReplay",
                      JSON.stringify([flowId, mutations ?? {}]),
                    );
                  },
                  enumerable: true,
                },
              }));
              Object.defineProperty(globalThis, "security", {
                value: securityApi,
                configurable: false,
                enumerable: true,
                writable: false,
              });

              // --- agent API (LLM-friendly helpers) ---
              const agentApi = Object.freeze(Object.create(null, {
                summarize: {
                  value: async (pageOrName, options) => {
                    const name = typeof pageOrName === "string"
                      ? pageOrName
                      : (pageOrName && typeof pageOrName._pageName === "string"
                          ? pageOrName._pageName
                          : null);
                    if (!name) {
                      throw new TypeError(
                        "agent.summarize: first argument must be a page name string",
                      );
                    }
                    return await hostCall(
                      "agentSummarize",
                      JSON.stringify([name, options ?? {}]),
                    );
                  },
                  enumerable: true,
                },
                stableSelector: {
                  value: async (pageOrName, target) => {
                    const name = typeof pageOrName === "string" ? pageOrName : null;
                    if (!name) {
                      throw new TypeError(
                        "agent.stableSelector: first argument must be a page name string",
                      );
                    }
                    return await hostCall(
                      "agentStableSelector",
                      JSON.stringify([name, target]),
                    );
                  },
                  enumerable: true,
                },
                actIntent: {
                  value: async (pageOrName, intent, options) => {
                    const name = typeof pageOrName === "string" ? pageOrName : null;
                    if (!name) {
                      throw new TypeError(
                        "agent.actIntent: first argument must be a page name string",
                      );
                    }
                    return await hostCall(
                      "agentActIntent",
                      JSON.stringify([name, intent, options ?? {}]),
                    );
                  },
                  enumerable: true,
                },
              }));
              Object.defineProperty(globalThis, "agent", {
                value: agentApi,
                configurable: false,
                enumerable: true,
                writable: false,
              });

              // --- cloudflare API (challenge detection / bypass helpers) ---
              const cloudflareApi = Object.freeze(Object.create(null, {
                detect: {
                  value: async (pageName) => {
                    return await hostCall("cloudflareDetect", JSON.stringify([pageName]));
                  },
                  enumerable: true,
                },
                waitForPass: {
                  value: async (pageName, options) => {
                    return await hostCall(
                      "cloudflareWaitForPass",
                      JSON.stringify([pageName, options ?? {}]),
                    );
                  },
                  enumerable: true,
                },
                waitForSolve: {
                  value: async (pageName, options) => {
                    return await hostCall(
                      "cloudflareWaitForSolve",
                      JSON.stringify([pageName, options ?? {}]),
                    );
                  },
                  enumerable: true,
                },
                saveClearance: {
                  value: async (domain) => {
                    return await hostCall("cloudflareSaveClearance", JSON.stringify([domain]));
                  },
                  enumerable: true,
                },
                restoreClearance: {
                  value: async (domain) => {
                    return await hostCall(
                      "cloudflareRestoreClearance",
                      JSON.stringify([domain]),
                    );
                  },
                  enumerable: true,
                },
                stealthArgs: {
                  value: async (options) => {
                    return await hostCall(
                      "cloudflareStealthArgs",
                      JSON.stringify([options ?? {}]),
                    );
                  },
                  enumerable: true,
                },
              }));
              Object.defineProperty(globalThis, "cloudflare", {
                value: cloudflareApi,
                configurable: false,
                enumerable: true,
                writable: false,
              });

              // --- scenario API (pure-sandbox orchestration helpers) ---
              const scenarioApi = (() => {
                function parallel(fns) {
                  if (!Array.isArray(fns) || fns.length === 0) {
                    return Promise.resolve([]);
                  }
                  return Promise.all(fns.map((fn, i) => {
                    if (typeof fn !== "function") {
                      return Promise.reject(new TypeError(\`scenario.parallel: item \${i} is not a function\`));
                    }
                    return Promise.resolve().then(() => fn());
                  }));
                }

                function race(fns) {
                  if (!Array.isArray(fns) || fns.length === 0) {
                    return Promise.reject(new Error("scenario.race: need at least one function"));
                  }
                  return Promise.race(fns.map((fn, i) => {
                    if (typeof fn !== "function") {
                      return Promise.reject(new TypeError(\`scenario.race: item \${i} is not a function\`));
                    }
                    return Promise.resolve().then(() => fn());
                  }));
                }

                function barrier(count) {
                  const n = count | 0;
                  if (n < 1) throw new RangeError("barrier count must be >= 1");
                  let arrived = 0;
                  let waiters = [];
                  let released = false;
                  return Object.freeze({
                    signal() {
                      arrived++;
                      if (arrived >= n && !released) {
                        released = true;
                        const w = waiters.splice(0);
                        for (const resolve of w) resolve();
                      }
                    },
                    wait() {
                      if (released) return Promise.resolve();
                      return new Promise((resolve) => { waiters.push(resolve); });
                    },
                    get arrived() { return arrived; },
                    get needed() { return n; },
                  });
                }

                function observe(page, fn) {
                  if (typeof fn !== "function") {
                    throw new TypeError("scenario.observe: second argument must be a function");
                  }
                  const events = [];
                  const ts = () => Date.now();

                  const onResponse = (resp) => {
                    events.push({ type: "response", url: resp.url(), status: resp.status(), timestamp: ts() });
                  };
                  const onConsole = (msg) => {
                    if (msg.type() === "error" || msg.type() === "warning") {
                      events.push({ type: "console", level: msg.type(), text: msg.text(), timestamp: ts() });
                    }
                  };

                  page.on("response", onResponse);
                  page.on("console", onConsole);

                  return Promise.resolve()
                    .then(() => fn(page))
                    .finally(() => {
                      try { page.off("response", onResponse); } catch {}
                      try { page.off("console", onConsole); } catch {}
                    })
                    .then((result) => ({ result, events }));
                }

                return Object.freeze(Object.create(null, {
                  parallel: { value: parallel, enumerable: true },
                  race: { value: race, enumerable: true },
                  barrier: { value: barrier, enumerable: true },
                  observe: { value: observe, enumerable: true },
                }));
              })();
              Object.defineProperty(globalThis, "scenario", {
                value: scenarioApi,
                configurable: false,
                enumerable: true,
                writable: false,
              });
            })();
          })()
        `,
        {
          filename: "sandbox-init.js",
        }
      );

      await this.#flushTransportQueue();
      this.#throwIfAsyncError();
      this.#initialized = true;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async executeScript(script: string): Promise<void> {
    this.#assertInitialized();
    let executionError: unknown;

    try {
      this.#throwIfAsyncError();

      await this.#host!.executeScript(
        wrapScriptWithWallClockTimeout(script, this.#options.timeoutMs),
        {
          filename: "user-script.js",
        }
      );

      await this.#flushTransportQueue();
      this.#throwIfAsyncError();
    } catch (error) {
      executionError = error;
    }

    try {
      await this.#cleanupAnonymousPages();
    } catch (error) {
      executionError ??= error;
    }

    if (executionError) {
      throw this.#redactError(executionError);
    }
  }

  #redactError(error: unknown): unknown {
    if (this.#redactor.isEmpty) {
      return error;
    }
    if (error instanceof Error) {
      error.message = this.#redactor.redact(error.message);
      if (error.stack) {
        error.stack = this.#redactor.redact(error.stack);
      }
      return error;
    }
    return typeof error === "string" ? this.#redactor.redact(error) : error;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;

    await this.#cleanupAnonymousPages({
      suppressErrors: true,
    });

    this.#transportInbox.length = 0;
    this.#pendingHostOperations.clear();

    try {
      await this.#networkManager?.dispose();
    } catch {
      // Best effort cleanup during sandbox teardown.
    } finally {
      this.#networkManager = undefined;
    }

    try {
      await this.#hostBridge?.dispose();
    } catch {
      // Best effort cleanup during sandbox teardown.
    } finally {
      this.#hostBridge = undefined;
      this.#host?.dispose();
      this.#host = undefined;
      this.#flushPromise = undefined;
    }
  }

  #routeConsole(level: QuickJSConsoleLevel, args: unknown[]): void {
    const line = `${this.#redactor.redact(formatArgs(args))}\n`;
    if (level === "warn" || level === "error") {
      this.#options.onStderr(line);
      return;
    }

    this.#options.onStdout(line);
  }

  #handleTransportSend(message: string): void {
    if (!this.#hostBridge) {
      this.#asyncError ??= new Error("Sandbox transport is not initialized");
      return;
    }

    const operation = this.#hostBridge
      .receiveFromSandbox(message)
      .catch((error: unknown) => {
        this.#asyncError ??= normalizeError(error);
      })
      .finally(() => {
        this.#pendingHostOperations.delete(operation);
      });

    this.#pendingHostOperations.add(operation);
  }

  async #drainAsyncOps(): Promise<void> {
    this.#throwIfAsyncError();
    await this.#flushTransportQueue();
    this.#throwIfAsyncError();

    if (this.#pendingHostOperations.size === 0) {
      return;
    }

    await Promise.race(this.#pendingHostOperations);
    this.#throwIfAsyncError();
    await this.#flushTransportQueue();
    this.#throwIfAsyncError();
  }

  async #flushTransportQueue(): Promise<void> {
    this.#throwIfAsyncError();
    if (!this.#host || this.#transportInbox.length === 0) {
      return;
    }

    if (this.#flushPromise) {
      await this.#flushPromise;
      return;
    }

    const flush = async () => {
      while (this.#transportInbox.length > 0) {
        const message = this.#transportInbox.shift();
        if (message === undefined) {
          continue;
        }

        await this.#host!.callFunction(TRANSPORT_RECEIVE_GLOBAL, message);
        this.#throwIfAsyncError();
      }
    };

    this.#flushPromise = flush().finally(() => {
      this.#flushPromise = undefined;
    });
    await this.#flushPromise;
  }

  async #getPage(name: unknown): Promise<string> {
    const pageName = requireString(name, "Page name or targetId");
    const page = await this.#options.manager.getPage(this.#options.browserName, pageName);
    ErrorCollector.attachToPage(pageName, page);
    return extractGuid(page);
  }

  async #newPage(): Promise<string> {
    const page = await this.#options.manager.newPage(this.#options.browserName);
    this.#anonymousPages.add(page);
    page.on("close", () => {
      this.#anonymousPages.delete(page);
    });
    return extractGuid(page);
  }

  async #closePage(name: unknown): Promise<void> {
    await this.#options.manager.closePage(
      this.#options.browserName,
      requireString(name, "Page name")
    );
  }

  async #writeTempFile(name: unknown, payload: unknown): Promise<string> {
    const data = decodeSandboxFilePayload(payload, "File data");
    return await writeDevBrowserTempFile(
      requireString(name, "File name"),
      typeof data === "string" ? this.#redactor.redact(data) : data
    );
  }

  async #readTempFile(name: unknown): Promise<string> {
    return await readDevBrowserTempFile(requireString(name, "File name"));
  }

  async #sessionSave(name: unknown, options: unknown): Promise<unknown> {
    const entry = this.#options.manager.getBrowser(this.#options.browserName);
    if (!entry) {
      throw new Error(`Browser "${this.#options.browserName}" not found`);
    }
    return await SessionManager.saveSession(entry.context, entry.pages, name, options);
  }

  async #sessionRestore(name: unknown, options: unknown): Promise<unknown> {
    const entry = this.#options.manager.getBrowser(this.#options.browserName);
    if (!entry) {
      throw new Error(`Browser "${this.#options.browserName}" not found`);
    }
    return await SessionManager.restoreSession(entry.context, entry.pages, name, options);
  }

  async #auditPage(
    kind: "accessibility" | "performance" | "full",
    pageName: unknown,
    options: unknown
  ): Promise<unknown> {
    const name = requireString(pageName, "Page name for audit");
    const entry = this.#options.manager.getBrowser(this.#options.browserName);
    if (!entry) throw new Error(`Browser "${this.#options.browserName}" not found`);
    const page = entry.pages.get(name);
    if (!page) throw new Error(`No named page "${name}" — call browser.getPage("${name}") first`);
    const opts = (options && typeof options === "object" ? options : {}) as Record<string, unknown>;
    if (kind === "accessibility") return await AuditManager.auditAccessibility(page, opts);
    if (kind === "performance") return await AuditManager.auditPerformance(page, opts);
    return await AuditManager.auditFull(page, opts);
  }

  #requireContext() {
    const entry = this.#options.manager.getBrowser(this.#options.browserName);
    if (!entry) throw new Error(`Browser "${this.#options.browserName}" not found`);
    return entry;
  }

  #requireNamedPage(pageName: unknown) {
    const name = requireString(pageName, "Page name");
    const entry = this.#requireContext();
    const page = entry.pages.get(name);
    if (!page) {
      throw new Error(`No named page "${name}" — call browser.getPage("${name}") first`);
    }
    return { entry, page };
  }

  async #cookiesGet(urls: unknown): Promise<unknown> {
    const { entry } = { entry: this.#requireContext() };
    return CookieManager.getCookies(entry.context, urls);
  }

  async #cookiesSet(cookies: unknown): Promise<void> {
    const entry = this.#requireContext();
    await CookieManager.setCookies(entry.context, cookies);
  }

  async #cookiesDelete(filter: unknown): Promise<void> {
    const entry = this.#requireContext();
    await CookieManager.deleteCookies(entry.context, filter);
  }

  async #auditSecurityHeaders(pageName: unknown, options: unknown): Promise<unknown> {
    const { page } = this.#requireNamedPage(pageName);
    const opts = (options && typeof options === "object" ? options : {}) as AuditManager.SecurityHeadersOptions;
    return AuditManager.auditSecurityHeaders(page, opts);
  }

  #requireLogEntry(index: unknown) {
    if (!this.#networkManager) {
      throw new Error("Network manager is not available");
    }
    return this.#networkManager.getLogEntry(index);
  }

  async #securityReplay(index: unknown, modifications: unknown): Promise<unknown> {
    const entry = this.#requireContext();
    const logEntry = this.#requireLogEntry(index);
    const mods = (modifications && typeof modifications === "object"
      ? modifications
      : {}) as SecurityManager.ReplayModifications;
    return SecurityManager.replayRequest(entry.context, logEntry, mods);
  }

  async #securityInspectCertificate(pageName: unknown): Promise<unknown> {
    const { entry, page } = this.#requireNamedPage(pageName);
    return SecurityManager.inspectCertificate(entry.context, page);
  }

  async #securityDetectXSS(pageName: unknown, options: unknown): Promise<unknown> {
    const { page } = this.#requireNamedPage(pageName);
    const opts = (options && typeof options === "object" ? options : {}) as SecurityManager.XSSOptions;
    return SecurityManager.detectXSS(page, opts);
  }

  async #securityExtractCSRF(pageName: unknown): Promise<unknown> {
    const { page } = this.#requireNamedPage(pageName);
    return SecurityManager.extractCSRFTokens(page);
  }

  async #securityReplayWithCSRF(
    index: unknown,
    token: unknown,
    options: unknown
  ): Promise<unknown> {
    const entry = this.#requireContext();
    const logEntry = this.#requireLogEntry(index);
    const tokenStr = requireString(token, "CSRF token");
    const opts = (options && typeof options === "object" ? options : {}) as {
      headerName?: string;
      paramName?: string;
    };
    return SecurityManager.replayWithCSRF(entry.context, logEntry, tokenStr, opts);
  }

  async #securityDetectForms(pageName: unknown): Promise<unknown> {
    const { page } = this.#requireNamedPage(pageName);
    return FormManager.detectForms(page);
  }

  async #securityAutoFill(pageName: unknown, credentials: unknown): Promise<void> {
    const { page } = this.#requireNamedPage(pageName);
    if (!credentials || typeof credentials !== "object") {
      throw new TypeError("security.autoFill: credentials must be an object");
    }
    await FormManager.autoFillForm(page, credentials as FormManager.LoginCredentials);
  }

  async #securitySubmitForm(
    pageName: unknown,
    selector: unknown,
    data: unknown
  ): Promise<void> {
    const { page } = this.#requireNamedPage(pageName);
    const sel = requireString(selector, "Form selector");
    if (!data || typeof data !== "object") {
      throw new TypeError("security.submitForm: data must be an object");
    }
    await FormManager.submitForm(page, sel, data as Record<string, string>);
  }

  async #securityFuzz(index: unknown, config: unknown): Promise<unknown> {
    const entry = this.#requireContext();
    const logEntry = this.#requireLogEntry(index);
    const cfg = (config && typeof config === "object" ? config : {}) as FuzzingManager.FuzzConfig;
    return FuzzingManager.fuzzRequest(entry.context, logEntry, cfg);
  }

  async #agentSummarize(pageName: unknown, options: unknown): Promise<unknown> {
    const { page } = this.#requireNamedPage(pageName);
    const opts = (options && typeof options === "object" ? options : {}) as AgentManager.SummarizeOptions;
    return AgentManager.summarizePage(page, opts);
  }

  async #agentStableSelector(pageName: unknown, target: unknown): Promise<unknown> {
    const { page } = this.#requireNamedPage(pageName);
    const sel = requireString(target, "Selector target");
    return AgentManager.resolveStableSelector(page, sel);
  }

  async #agentActIntent(
    pageName: unknown,
    intent: unknown,
    options: unknown
  ): Promise<unknown> {
    const { page } = this.#requireNamedPage(pageName);
    const intentStr = requireString(intent, "Intent");
    const opts = (options && typeof options === "object" ? options : {}) as AgentManager.ActIntentOptions;
    return AgentManager.actIntent(page, intentStr, opts);
  }

  async #auditMixedContent(pageName: unknown, options: unknown): Promise<unknown> {
    const { page } = this.#requireNamedPage(pageName);
    const opts = (options && typeof options === "object" ? options : {}) as AuditManager.MixedContentOptions;
    const log = this.#networkManager?.getLog() ?? [];
    return AuditManager.auditMixedContent(page, log, opts);
  }

  async #auditAuth(pageName: unknown, options: unknown): Promise<unknown> {
    const { entry, page } = this.#requireNamedPage(pageName);
    const opts = (options && typeof options === "object" ? options : {}) as AuditManager.AuthAuditOptions;
    return AuditManager.auditAuth(entry.context, page, opts);
  }

  #authFlowsDetect(): unknown {
    const log = this.#networkManager?.getLog() ?? [];
    return AuthFlowManager.detectAuthFlows(log);
  }

  async #authFlowsReplay(flowId: unknown, mutations: unknown): Promise<unknown> {
    const entry = this.#requireContext();
    const log = this.#networkManager?.getLog() ?? [];
    const id = requireString(flowId, "Auth flow id");
    const muts = (mutations && typeof mutations === "object"
      ? mutations
      : {}) as AuthFlowManager.AuthReplayMutations;
    return AuthFlowManager.replayAuthFlow(entry.context, log, id, muts);
  }

  async #cloudflareDetect(pageName: unknown): Promise<unknown> {
    const { page } = this.#requireNamedPage(pageName);
    const log = this.#networkManager?.getLog() ?? [];
    return CloudflareManager.detectState(page, { networkLog: log });
  }

  async #cloudflareWaitForPass(pageName: unknown, options: unknown): Promise<unknown> {
    const { page } = this.#requireNamedPage(pageName);
    const log = this.#networkManager?.getLog() ?? [];
    const opts = (options && typeof options === "object"
      ? options
      : {}) as CloudflareManager.WaitForPassOptions;
    return CloudflareManager.waitForPass(page, { ...opts, networkLog: log });
  }

  async #cloudflareWaitForSolve(pageName: unknown, options: unknown): Promise<unknown> {
    const { page } = this.#requireNamedPage(pageName);
    const log = this.#networkManager?.getLog() ?? [];
    const opts = (options && typeof options === "object"
      ? options
      : {}) as CloudflareManager.WaitForSolveOptions;
    return CloudflareManager.waitForSolve(page, { ...opts, networkLog: log });
  }

  async #cloudflareSaveClearance(domain: unknown): Promise<unknown> {
    const entry = this.#requireContext();
    const d = requireString(domain, "Cloudflare clearance domain");
    return CloudflareManager.saveClearance(entry.context, d);
  }

  async #cloudflareRestoreClearance(domain: unknown): Promise<unknown> {
    const entry = this.#requireContext();
    const d = requireString(domain, "Cloudflare clearance domain");
    return CloudflareManager.restoreClearance(entry.context, d);
  }

  #cloudflareStealthArgs(options: unknown): unknown {
    const opts = (options && typeof options === "object"
      ? options
      : {}) as CloudflareManager.StealthLaunchOptions;
    return CloudflareManager.stealthLaunchArgs(opts);
  }

  async #cleanupAnonymousPages(options: { suppressErrors?: boolean } = {}): Promise<void> {
    const anonymousPages = [...this.#anonymousPages];
    this.#anonymousPages.clear();

    for (const page of anonymousPages) {
      try {
        if (!page.isClosed()) {
          await page.close();
        }
      } catch (error) {
        if (!options.suppressErrors) {
          throw error;
        }
      }
    }

    if (options.suppressErrors) {
      try {
        await this.#flushTransportQueue();
      } catch {
        // Best effort cleanup during sandbox teardown.
      }
      return;
    }

    await this.#flushTransportQueue();
    this.#throwIfAsyncError();
  }

  #throwIfAsyncError(): void {
    if (this.#asyncError) {
      throw this.#asyncError;
    }
  }

  #assertAlive(): void {
    if (this.#disposed) {
      throw new Error("QuickJS sandbox has been disposed");
    }
  }

  #assertInitialized(): void {
    this.#assertAlive();
    if (!this.#initialized || !this.#host || !this.#hostBridge) {
      throw new Error("QuickJS sandbox has not been initialized");
    }
  }
}
