import express, { type Express, type Request, type Response } from "express";
import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";
import type { Socket } from "net";
import type {
  ServeOptions,
  GetPageRequest,
  GetPageResponse,
  ListPagesResponse,
  ServerInfoResponse,
  EvaluateRequest,
  EvaluateResponse,
  SnapshotResponse,
  NavigateRequest,
  NavigateResponse,
} from "./types";
import { getSnapshotScript } from "./snapshot/browser-script.js";
import {
  loadConfig,
  findAvailablePort,
  registerServer,
  unregisterServer,
  outputPortForDiscovery,
  cleanupOrphanedBrowsers,
} from "./config.js";

export type { ServeOptions, GetPageResponse, ListPagesResponse, ServerInfoResponse };

// Re-export external browser mode
export {
  serveWithExternalBrowser,
  type ExternalBrowserOptions,
  type ExternalBrowserServer,
} from "./external-browser.js";

// Re-export configuration utilities
export {
  loadConfig,
  findAvailablePort,
  cleanupOrphanedBrowsers,
  detectOrphanedBrowsers,
  type DevBrowserConfig,
  type BrowserConfig,
  type BrowserMode,
  type ServerInfo,
  type OrphanedBrowser,
} from "./config.js";

export interface DevBrowserServer {
  wsEndpoint: string;
  port: number;
  stop: () => Promise<void>;
}

// Helper to retry fetch with exponential backoff
async function fetchWithRetry(
  url: string,
  maxRetries = 5,
  delayMs = 500
): Promise<globalThis.Response> {
  let lastError: Error | null = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
      }
    }
  }
  throw new Error(`Failed after ${maxRetries} retries: ${lastError?.message}`);
}

// Helper to add timeout to promises
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${message}`)), ms)
    ),
  ]);
}

export async function serve(options: ServeOptions = {}): Promise<DevBrowserServer> {
  const config = loadConfig();

  // Use dynamic port allocation if port not specified
  const port = options.port ?? await findAvailablePort(config);
  const headless = options.headless ?? false;
  const cdpPort = options.cdpPort ?? config.cdpPort;
  const profileDir = options.profileDir;

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

  // Determine user data directory for persistent context
  const userDataDir = profileDir
    ? join(profileDir, "browser-data")
    : join(process.cwd(), ".browser-data");

  // Create directory if it doesn't exist
  mkdirSync(userDataDir, { recursive: true });
  console.log(`Using persistent browser profile: ${userDataDir}`);

  // Clean up any orphaned browsers from previous crashed sessions
  // This handles the case where Node crashed but Chrome is still running on the CDP port
  const orphansCleaned = cleanupOrphanedBrowsers([cdpPort]);
  if (orphansCleaned > 0) {
    // Give the OS a moment to release the port
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log("Launching browser with persistent context...");

  // Launch persistent context - this persists cookies, localStorage, cache, etc.
  const context: BrowserContext = await chromium.launchPersistentContext(userDataDir, {
    headless,
    args: [`--remote-debugging-port=${cdpPort}`],
  });
  console.log("Browser launched with persistent profile...");

  // Get the CDP WebSocket endpoint from Chrome's JSON API (with retry for slow startup)
  const cdpResponse = await fetchWithRetry(`http://127.0.0.1:${cdpPort}/json/version`);
  const cdpInfo = (await cdpResponse.json()) as { webSocketDebuggerUrl: string };
  const wsEndpoint = cdpInfo.webSocketDebuggerUrl;
  console.log(`CDP WebSocket endpoint: ${wsEndpoint}`);

  // Registry entry type for page tracking
  interface PageEntry {
    page: Page;
    targetId: string;
  }

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

  // GET / - server info
  app.get("/", (_req: Request, res: Response) => {
    const response: ServerInfoResponse = { wsEndpoint };
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
      // Create new page in the persistent context (with timeout to prevent hangs)
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

  // POST /pages/:name/navigate - navigate to URL
  app.post("/pages/:name/navigate", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: "page not found" });
      return;
    }

    const { url, waitUntil } = req.body as { url?: string; waitUntil?: "load" | "domcontentloaded" | "networkidle" };
    if (!url) {
      res.status(400).json({ error: "url is required" });
      return;
    }

    try {
      await entry.page.goto(url, { waitUntil: waitUntil || "domcontentloaded" });
      res.json({
        url: entry.page.url(),
        title: await entry.page.title(),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/evaluate - evaluate JavaScript
  app.post("/pages/:name/evaluate", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: "page not found" });
      return;
    }

    const { expression } = req.body as { expression?: string };
    if (!expression) {
      res.status(400).json({ error: "expression is required" });
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await entry.page.evaluate((expr: string) => eval(expr), expression);
      res.json({ result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /pages/:name/snapshot - get AI snapshot
  app.get("/pages/:name/snapshot", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: "page not found" });
      return;
    }

    try {
      const snapshotScript = getSnapshotScript();
      const snapshot = await entry.page.evaluate((script: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = globalThis as any;
        if (!w.__devBrowser_getAISnapshot) {
          // eslint-disable-next-line no-eval
          eval(script);
        }
        return w.__devBrowser_getAISnapshot();
      }, snapshotScript);

      res.json({ snapshot });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/select-ref - get element info by ref
  app.post("/pages/:name/select-ref", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: "page not found" });
      return;
    }

    const { ref } = req.body as { ref?: string };
    if (!ref) {
      res.status(400).json({ error: "ref is required" });
      return;
    }

    try {
      const elementInfo = await entry.page.evaluate((refId: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = globalThis as any;
        const refs = w.__devBrowserRefs;
        if (!refs) {
          throw new Error("No snapshot refs found. Call snapshot first.");
        }
        const element = refs[refId];
        if (!element) {
          return { found: false };
        }
        return {
          found: true,
          tagName: element.tagName,
          textContent: element.textContent?.slice(0, 500),
        };
      }, ref);

      res.json(elementInfo);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/click - click on element by ref
  app.post("/pages/:name/click", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: "page not found" });
      return;
    }

    const { ref } = req.body as { ref?: string };
    if (!ref) {
      res.status(400).json({ error: "ref is required" });
      return;
    }

    try {
      const elementHandle = await entry.page.evaluateHandle((refId: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = globalThis as any;
        const refs = w.__devBrowserRefs;
        if (!refs) throw new Error("No snapshot refs found. Call snapshot first.");
        const element = refs[refId];
        if (!element) throw new Error(`Ref "${refId}" not found`);
        return element;
      }, ref);

      const element = elementHandle.asElement();
      if (!element) {
        res.status(400).json({ error: "Could not get element handle" });
        return;
      }

      await element.click();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/fill - fill input by ref
  app.post("/pages/:name/fill", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: "page not found" });
      return;
    }

    const { ref, value } = req.body as { ref?: string; value?: string };
    if (!ref) {
      res.status(400).json({ error: "ref is required" });
      return;
    }
    if (value === undefined) {
      res.status(400).json({ error: "value is required" });
      return;
    }

    try {
      const elementHandle = await entry.page.evaluateHandle((refId: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = globalThis as any;
        const refs = w.__devBrowserRefs;
        if (!refs) throw new Error("No snapshot refs found. Call snapshot first.");
        const element = refs[refId];
        if (!element) throw new Error(`Ref "${refId}" not found`);
        return element;
      }, ref);

      const element = elementHandle.asElement();
      if (!element) {
        res.status(400).json({ error: "Could not get element handle" });
        return;
      }

      await element.fill(value);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Start the server
  const server = app.listen(port, () => {
    console.log(`HTTP API server running on port ${port}`);
  });

  // Register this server for multi-agent coordination (standalone mode owns the browser)
  registerServer(port, process.pid, { cdpPort, mode: "standalone" });

  // Output port for agent discovery (agents parse this to know which port to connect to)
  outputPortForDiscovery(port);

  // Track active connections for clean shutdown
  const connections = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });

  // Track if cleanup has been called to avoid double cleanup
  let cleaningUp = false;

  // Cleanup function
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;

    console.log("\nShutting down...");

    // Close all active HTTP connections
    for (const socket of connections) {
      socket.destroy();
    }
    connections.clear();

    // Close all pages
    for (const entry of registry.values()) {
      try {
        await entry.page.close();
      } catch {
        // Page might already be closed
      }
    }
    registry.clear();

    // Close context (this also closes the browser)
    try {
      await context.close();
    } catch {
      // Context might already be closed
    }

    server.close();

    // Unregister this server
    const remainingServers = unregisterServer(port);
    console.log(`Server stopped. ${remainingServers} other server(s) still running.`);
  };

  // Synchronous cleanup for forced exits
  const syncCleanup = () => {
    try {
      context.close();
    } catch {
      // Best effort
    }
  };

  // Signal handlers (consolidated to reduce duplication)
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
  process.on("exit", syncCleanup);

  // Helper to remove all handlers
  const removeHandlers = () => {
    signals.forEach((sig) => process.off(sig, signalHandler));
    process.off("uncaughtException", errorHandler);
    process.off("unhandledRejection", errorHandler);
    process.off("exit", syncCleanup);
  };

  return {
    wsEndpoint,
    port,
    async stop() {
      removeHandlers();
      await cleanup();
    },
  };
}
