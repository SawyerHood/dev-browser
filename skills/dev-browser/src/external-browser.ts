import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { spawn } from "child_process";
import type { Socket } from "net";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, "..");
import type {
  GetPageRequest,
  GetPageResponse,
  ListPagesResponse,
  ServerInfoResponse,
} from "./types";
import { registerPageRoutes, type PageEntry } from "./http-routes.js";
import {
  loadConfig,
  findAvailablePort,
  registerServer,
  unregisterServer,
  outputPortForDiscovery,
  writePortFile,
  killStaleServers,
  getStateDir,
} from "./config.js";

/** Idle timeout in milliseconds (30 minutes) */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface ExternalBrowserOptions {
  /**
   * HTTP API port. If not specified, a port is automatically assigned
   * from the configured range (default: 19222-19300, step 2).
   * This enables multiple agents to run concurrently.
   */
  port?: number;
  /** CDP port where external browser is listening (default: 9223) */
  cdpPort?: number;
  /** Path to browser executable (for auto-launch) */
  browserPath?: string;
  /** User data directory for browser profile (for auto-launch) */
  userDataDir?: string;
  /** Extra command-line arguments to pass to the browser */
  extraArgs?: string[];
  /** Whether to auto-launch browser if not running (default: true) */
  autoLaunch?: boolean;
  /** Idle timeout in ms before auto-shutdown (default: 30 minutes, 0 to disable) */
  idleTimeout?: number;
}

export interface ExternalBrowserServer {
  wsEndpoint: string;
  port: number;
  mode: "external-browser";
  stop: () => Promise<void>;
}

/**
 * Check if a browser is running on the specified CDP port
 */
async function isBrowserRunning(cdpPort: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Get the CDP WebSocket endpoint from a running browser
 */
async function getCdpEndpoint(cdpPort: number, maxRetries = 60): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const data = (await res.json()) as { webSocketDebuggerUrl: string };
        return data.webSocketDebuggerUrl;
      }
    } catch {
      // Browser not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Browser did not start on port ${cdpPort} within ${maxRetries * 0.5}s`);
}

/**
 * Launch browser as a detached process (survives server shutdown)
 *
 * On macOS, if browserPath ends with .app (an app bundle), uses `open -a`
 * for proper Dock icon integration. The app should handle CDP flags internally.
 */
function launchBrowserDetached(
  browserPath: string,
  cdpPort: number,
  userDataDir?: string,
  extraArgs?: string[]
): void {
  // On macOS, if path is an app bundle, use `open -a` for proper Dock icon
  if (process.platform === "darwin" && browserPath.endsWith(".app")) {
    console.log(`Launching macOS app: ${browserPath}`);
    console.log(`  (App handles CDP port and user data dir internally)`);

    const child = spawn("open", ["-a", browserPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return;
  }

  // Chrome requires a non-default user-data-dir for CDP debugging.
  // If not explicitly configured, use a default profile in the state directory.
  const effectiveUserDataDir = userDataDir || join(getStateDir(), "chrome-profile");

  // Standard launch: spawn binary directly with CDP flags
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${effectiveUserDataDir}`,
    ...(extraArgs || []),
  ];

  console.log(`Launching browser: ${browserPath}`);
  console.log(`  CDP port: ${cdpPort}`);
  console.log(`  User data: ${effectiveUserDataDir}`);
  if (extraArgs?.length) {
    console.log(`  Extra args: ${extraArgs.join(" ")}`);
  }

  const child = spawn(browserPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/**
 * Helper to add timeout to promises
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${message}`)), ms)
    ),
  ]);
}

/**
 * Serve dev-browser by connecting to an external browser via CDP.
 *
 * This mode is ideal for:
 * - Using Chrome for Testing or other specific browser builds
 * - Keeping the browser open after automation (for manual inspection)
 * - Development workflows where you want to see automation in a visible browser
 *
 * The browser lifecycle is managed externally - this server only connects/disconnects.
 */
export async function serveWithExternalBrowser(
  options: ExternalBrowserOptions = {}
): Promise<ExternalBrowserServer> {
  // Clean up stale server entries on startup
  killStaleServers();

  const config = loadConfig();

  // Use dynamic port allocation if port not specified
  const port = options.port ?? await findAvailablePort(config);
  const cdpPort = options.cdpPort ?? config.cdpPort;
  const autoLaunch = options.autoLaunch ?? true;
  const browserPath = options.browserPath;
  // Only use userDataDir if explicitly provided - let browser use default profile otherwise
  const userDataDir = options.userDataDir;
  const extraArgs = options.extraArgs;
  const idleTimeout = options.idleTimeout ?? IDLE_TIMEOUT_MS;

  // Validate port numbers
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}. Must be between 1 and 65535`);
  }
  if (cdpPort < 1 || cdpPort > 65535) {
    throw new Error(`Invalid cdpPort: ${cdpPort}. Must be between 1 and 65535`);
  }
  if (port === cdpPort) {
    throw new Error("port and cdpPort must be different");
  }

  // Check if browser is running, optionally launch it
  const running = await isBrowserRunning(cdpPort);

  if (!running) {
    if (autoLaunch && browserPath) {
      console.log(`Browser not running on port ${cdpPort}, launching...`);
      launchBrowserDetached(browserPath, cdpPort, userDataDir, extraArgs);
    } else if (autoLaunch && !browserPath) {
      throw new Error(
        `Browser not running on port ${cdpPort} and no browserPath provided for auto-launch. ` +
        `Either start the browser manually with --remote-debugging-port=${cdpPort} or provide browserPath.`
      );
    } else {
      throw new Error(
        `Browser not running on port ${cdpPort}. ` +
        `Start it with --remote-debugging-port=${cdpPort}`
      );
    }
  } else {
    console.log(`Browser already running on port ${cdpPort}`);
  }

  // Wait for CDP endpoint
  console.log("Waiting for CDP endpoint...");
  const wsEndpoint = await getCdpEndpoint(cdpPort);
  console.log(`CDP WebSocket endpoint: ${wsEndpoint}`);

  // Connect to the browser via CDP
  console.log("Connecting to browser via CDP...");
  const browser: Browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  console.log("Connected to external browser");

  // Get the default context (user's browsing context)
  const contexts = browser.contexts();
  const context: BrowserContext = contexts[0] || await browser.newContext();

  // Registry: name -> PageEntry
  const registry = new Map<string, PageEntry>();

  // Helper to get CDP targetId for a page
  async function getTargetId(page: Page): Promise<string> {
    const cdpSession = await context.newCDPSession(page);
    try {
      const { targetInfo } = await cdpSession.send("Target.getTargetInfo");
      return targetInfo.targetId;
    } finally {
      await cdpSession.detach();
    }
  }

  // Express server for page management
  const app: Express = express();
  app.use(express.json());

  // Idle timeout tracking
  let lastActivityTime = Date.now();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  // Middleware to track activity and reset idle timer
  app.use((_req: Request, _res: Response, next: NextFunction) => {
    lastActivityTime = Date.now();
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    if (idleTimeout > 0) {
      idleTimer = setTimeout(() => {
        console.log(`\nShutting down due to ${idleTimeout / 1000 / 60} minutes of inactivity`);
        cleanup().then(() => process.exit(0));
      }, idleTimeout);
    }
    next();
  });

  // GET / - server info
  app.get("/", (_req: Request, res: Response) => {
    const response: ServerInfoResponse & { mode: string } = {
      wsEndpoint,
      mode: "external-browser",
    };
    res.json(response);
  });

  // GET /pages - list all pages
  app.get("/pages", (_req: Request, res: Response) => {
    const response: ListPagesResponse = {
      pages: Array.from(registry.keys()),
    };
    res.json(response);
  });

  // POST /pages - get or create page
  app.post("/pages", async (req: Request, res: Response) => {
    const body = req.body as GetPageRequest;
    const { name } = body;

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required and must be a string" });
      return;
    }

    if (name.length === 0) {
      res.status(400).json({ error: "name cannot be empty" });
      return;
    }

    if (name.length > 256) {
      res.status(400).json({ error: "name must be 256 characters or less" });
      return;
    }

    // Check if page already exists
    let entry = registry.get(name);
    if (!entry) {
      // Create new page in the context (with timeout to prevent hangs)
      const page = await withTimeout(context.newPage(), 30000, "Page creation timed out after 30s");
      const targetId = await getTargetId(page);
      entry = { page, targetId };
      registry.set(name, entry);

      // Clean up registry when page is closed (e.g., user clicks X)
      page.on("close", () => {
        registry.delete(name);
      });
    }

    const response: GetPageResponse = { wsEndpoint, name, targetId: entry.targetId, mode: "launch" };
    res.json(response);
  });

  // DELETE /pages/:name - close a page
  app.delete("/pages/:name", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (entry) {
      await entry.page.close();
      registry.delete(name);
      res.json({ success: true });
      return;
    }

    res.status(404).json({ error: "page not found" });
  });

  // Register shared page operation routes (navigate, evaluate, snapshot, click, fill, etc.)
  registerPageRoutes(app, registry);

  // Start the server
  const server = app.listen(port, () => {
    console.log(`HTTP API server running on port ${port}`);
  });

  // Register this server for multi-agent coordination (external mode doesn't own the browser)
  registerServer(port, process.pid, { cdpPort, mode: "external" });

  // Write port to tmp/port for client discovery
  writePortFile(port, SKILL_DIR);

  // Output port for agent discovery (agents parse this to know which port to connect to)
  outputPortForDiscovery(port);

  // Start the initial idle timer
  if (idleTimeout > 0) {
    idleTimer = setTimeout(() => {
      console.log(`\nShutting down due to ${idleTimeout / 1000 / 60} minutes of inactivity`);
      cleanup().then(() => process.exit(0));
    }, idleTimeout);
    console.log(`Idle timeout: ${idleTimeout / 1000 / 60} minutes`);
  }

  // Track active connections for clean shutdown
  const connections = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });

  // Track if cleanup has been called to avoid double cleanup
  let cleaningUp = false;

  // Cleanup function - disconnects but does NOT close the browser
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;

    // Clear idle timer
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    console.log("\nShutting down...");

    // Close all active HTTP connections
    for (const socket of connections) {
      socket.destroy();
    }
    connections.clear();

    // Close managed pages (pages we created, not user's existing tabs)
    for (const entry of registry.values()) {
      try {
        await entry.page.close();
      } catch {
        // Page might already be closed
      }
    }
    registry.clear();

    // Disconnect from browser (does NOT close it)
    try {
      await browser.close();
    } catch {
      // Already disconnected
    }

    server.close();

    // Unregister this server
    const remainingServers = unregisterServer(port);
    console.log(
      `Server stopped. Browser remains open. ` +
      `${remainingServers} other server(s) still running.`
    );
  };

  // Signal handlers
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

  const signalHandler = async () => {
    await cleanup();
    process.exit(0);
  };

  const errorHandler = async (err: unknown) => {
    console.error("Unhandled error:", err);
    await cleanup();
    process.exit(1);
  };

  // Register handlers
  signals.forEach((sig) => process.on(sig, signalHandler));
  process.on("uncaughtException", errorHandler);
  process.on("unhandledRejection", errorHandler);

  // Helper to remove all handlers
  const removeHandlers = () => {
    signals.forEach((sig) => process.off(sig, signalHandler));
    process.off("uncaughtException", errorHandler);
    process.off("unhandledRejection", errorHandler);
  };

  return {
    wsEndpoint,
    port,
    mode: "external-browser",
    async stop() {
      removeHandlers();
      await cleanup();
    },
  };
}
