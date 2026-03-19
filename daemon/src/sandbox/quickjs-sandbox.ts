import { readFile } from "node:fs/promises";
import util from "node:util";

import type { Page } from "playwright";

import type { BrowserManager } from "../browser-manager.js";
import {
  ensureDevBrowserTempDir,
  readDevBrowserTempFile,
  writeDevBrowserTempFile,
} from "../temp-files.js";
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

export interface QuickJSSandboxOptions {
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

  #asyncError?: Error;
  #host?: QuickJSHost;
  #hostBridge?: HostBridge;
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
      throw executionError;
    }
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
    const line = `${formatArgs(args)}\n`;
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
    const page = await this.#options.manager.getPage(
      this.#options.browserName,
      requireString(name, "Page name or targetId")
    );
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
    return await writeDevBrowserTempFile(
      requireString(name, "File name"),
      decodeSandboxFilePayload(payload, "File data")
    );
  }

  async #readTempFile(name: unknown): Promise<string> {
    return await readDevBrowserTempFile(requireString(name, "File name"));
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
