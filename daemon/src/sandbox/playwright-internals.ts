import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";

const require = createRequire(import.meta.url);
const currentDir = path.dirname(fileURLToPath(import.meta.url));

export type WireMessage = Record<string, unknown>;

export interface PlaywrightClientLike {
  chromium: {
    launch(options?: Record<string, unknown>): Promise<Browser>;
  };
}

export interface ClientConnectionLike {
  onmessage: (message: WireMessage) => void;
  initializePlaywright(): Promise<PlaywrightClientLike>;
  dispatch(message: WireMessage): void;
  close(cause?: string): void;
}

export interface DispatcherConnectionLike {
  onmessage: (message: WireMessage) => void;
  dispatch(message: WireMessage): Promise<void>;
}

export interface RootDispatcherLike {
  _dispose(): void;
}

export interface PlaywrightDispatcherLike {
  cleanup(): Promise<void>;
}

export interface RootInitializeParams {
  sdkLanguage?: string;
}

export interface HostBridgeDispatcherOptions {
  preLaunchedBrowser?: unknown;
  sharedBrowser?: boolean;
  denyLaunch?: boolean;
}

function resolvePlaywrightInternal(modulePath: string): string {
  const candidates = [
    path.resolve(currentDir, "../../node_modules/playwright-core", modulePath),
    path.resolve(currentDir, "node_modules/playwright-core", modulePath),
    path.resolve(process.cwd(), "node_modules/playwright-core", modulePath),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Could not locate Playwright internals at ${modulePath}`);
}

const serverInternals = require(resolvePlaywrightInternal(path.join("lib", "server", "index.js"))) as {
  createPlaywright: (options: { sdkLanguage: string }) => unknown;
  DispatcherConnection: new (isLocal?: boolean) => DispatcherConnectionLike;
  RootDispatcher: new (
    connection: DispatcherConnectionLike,
    createPlaywright?: (scope: unknown, params: RootInitializeParams) => Promise<unknown>
  ) => RootDispatcherLike;
  PlaywrightDispatcher: new (
    scope: unknown,
    playwright: unknown,
    options?: HostBridgeDispatcherOptions
  ) => PlaywrightDispatcherLike;
};

const clientInternals = require(
  resolvePlaywrightInternal(path.join("lib", "client", "connection.js"))
) as {
  Connection: new (platform: unknown) => ClientConnectionLike;
};

const nodePlatformInternals = require(resolvePlaywrightInternal(
  path.join("lib", "server", "utils", "nodePlatform.js")
)) as {
  nodePlatform: unknown;
};

export const {
  createPlaywright,
  DispatcherConnection,
  RootDispatcher,
  PlaywrightDispatcher,
} = serverInternals;

export const { Connection } = clientInternals;
export const { nodePlatform } = nodePlatformInternals;
