import express, { type Express, type Request, type Response } from "express";
import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";
import type { Socket } from "net";
import { createServer as createHttpServer } from "http";
import WebSocket, { WebSocketServer } from "ws";
import type {
  ServeOptions,
  GetPageRequest,
  GetPageResponse,
  ListPagesResponse,
  ServerInfoResponse,
} from "./types";

export type { ServeOptions, GetPageResponse, ListPagesResponse, ServerInfoResponse };

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
  const port = options.port ?? 9222;
  const host = options.host ?? "localhost";
  const headless = options.headless ?? false;
  const cdpPort = options.cdpPort ?? 9223;
  const profileDir = options.profileDir;
  const lazy = options.lazy ?? false;

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

  // Browser state - lazily initialized if lazy=true
  let context: BrowserContext | null = null;
  let wsEndpoint: string | null = null;
  let internalWsEndpoint: string | null = null;
  let browserLaunching: Promise<void> | null = null;

  // Function to launch the browser (called immediately or on first request)
  async function launchBrowser(): Promise<void> {
    if (context) return; // Already launched

    console.log("Launching browser with persistent context...");

    // Launch persistent context - this persists cookies, localStorage, cache, etc.
    // When host is 0.0.0.0, also bind Chrome's debugging port to all interfaces
    const cdpArgs = [`--remote-debugging-port=${cdpPort}`];
    if (host === "0.0.0.0") {
      cdpArgs.push("--remote-debugging-address=0.0.0.0");
    }
    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      args: cdpArgs,
    });
    console.log("Browser launched with persistent profile...");

    // Get the CDP WebSocket endpoint from Chrome's JSON API (with retry for slow startup)
    const cdpResponse = await fetchWithRetry(`http://127.0.0.1:${cdpPort}/json/version`);
    const cdpInfo = (await cdpResponse.json()) as { webSocketDebuggerUrl: string };
    internalWsEndpoint = cdpInfo.webSocketDebuggerUrl;
    console.log(`Internal CDP WebSocket endpoint: ${internalWsEndpoint}`);

    // Create proxied WebSocket endpoint that goes through our server
    // This works around Chrome ignoring --remote-debugging-address on macOS
    // Original: ws://127.0.0.1:9223/devtools/browser/xxx
    // Proxied:  ws://<host>:9222/devtools/browser/xxx
    const wsPath = new URL(internalWsEndpoint).pathname;
    wsEndpoint = `ws://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}${wsPath}`;
    console.log(`Proxied CDP WebSocket endpoint: ${wsEndpoint}`);
  }

  // Ensure browser is launched (with deduplication for concurrent requests)
  async function ensureBrowser(): Promise<void> {
    if (context) return;
    if (browserLaunching) {
      await browserLaunching;
      return;
    }
    browserLaunching = launchBrowser();
    await browserLaunching;
  }

  // Launch immediately unless lazy mode
  if (!lazy) {
    await launchBrowser();
  } else {
    console.log("Lazy mode: Browser will launch on first request");
  }

  // Registry entry type for page tracking
  interface PageEntry {
    page: Page;
    targetId: string;
  }

  // Registry: name -> PageEntry
  const registry = new Map<string, PageEntry>();

  // Helper to get CDP targetId for a page
  async function getTargetId(page: Page): Promise<string> {
    const cdpSession = await context!.newCDPSession(page);
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

  // GET / - server info (triggers browser launch if lazy)
  app.get("/", async (_req: Request, res: Response) => {
    await ensureBrowser();
    const response: ServerInfoResponse = { wsEndpoint: wsEndpoint! };
    res.json(response);
  });

  // GET /pages - list all pages
  app.get("/pages", (_req: Request, res: Response) => {
    const response: ListPagesResponse = {
      pages: Array.from(registry.keys()),
    };
    res.json(response);
  });

  // POST /pages - get or create page (triggers browser launch if lazy)
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

    // Ensure browser is launched
    await ensureBrowser();

    // Check if page already exists
    let entry = registry.get(name);
    if (!entry) {
      // Create new page in the persistent context (with timeout to prevent hangs)
      const page = await withTimeout(context!.newPage(), 30000, "Page creation timed out after 30s");
      const targetId = await getTargetId(page);
      entry = { page, targetId };
      registry.set(name, entry);

      // Clean up registry when page is closed (e.g., user clicks X)
      page.on("close", () => {
        registry.delete(name);
      });
    }

    const response: GetPageResponse = { wsEndpoint: wsEndpoint!, name, targetId: entry.targetId };
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

  // Create HTTP server
  const httpServer = createHttpServer(app);

  // Create WebSocket server for proxying CDP connections
  // This works around Chrome ignoring --remote-debugging-address on macOS
  const wss = new WebSocketServer({ noServer: true });

  // Handle WebSocket connections by proxying to Chrome's CDP
  wss.on("connection", (clientWs, req) => {
    const targetUrl = `ws://127.0.0.1:${cdpPort}${req.url}`;
    console.log(`Proxying WebSocket to: ${targetUrl}`);

    // Queue messages until Chrome connection is open
    const messageQueue: (Buffer | ArrayBuffer | Buffer[])[] = [];
    let chromeReady = false;

    const chromeWs = new WebSocket(targetUrl);

    chromeWs.on("open", () => {
      console.log("Connected to Chrome CDP");
      chromeReady = true;
      // Send any queued messages
      for (const msg of messageQueue) {
        chromeWs.send(msg);
      }
      messageQueue.length = 0;
    });

    chromeWs.on("message", (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
    });

    chromeWs.on("close", (code, reason) => {
      console.log(`Chrome WebSocket closed: code=${code} reason=${reason.toString()}`);
      clientWs.close(code, reason);
    });

    chromeWs.on("error", (err) => {
      console.error("Chrome WebSocket error:", err);
      clientWs.close();
    });

    clientWs.on("message", (data, isBinary) => {
      if (chromeReady && chromeWs.readyState === WebSocket.OPEN) {
        chromeWs.send(data, { binary: isBinary });
      } else {
        messageQueue.push(data);
      }
    });

    clientWs.on("close", (code, reason) => {
      console.log(`Client WebSocket closed: code=${code} reason=${reason.toString()}`);
      chromeWs.close();
    });

    clientWs.on("error", (err) => {
      console.error("Client WebSocket error:", err);
      chromeWs.close();
    });
  });

  // Handle upgrade requests (triggers browser launch if lazy)
  httpServer.on("upgrade", async (req, socket, head) => {
    if (req.url?.startsWith("/devtools")) {
      console.log(`WebSocket upgrade request: ${req.url}`);
      try {
        await ensureBrowser();
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      } catch (err) {
        console.error("Failed to launch browser for WebSocket:", err);
        socket.destroy();
      }
    } else {
      socket.destroy();
    }
  });

  // Start the server
  const server = httpServer.listen(port, host, () => {
    console.log(`HTTP API server running on ${host}:${port}`);
  });

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

    // Close context (this also closes the browser) - only if launched
    if (context) {
      try {
        await context.close();
      } catch {
        // Context might already be closed
      }
    }

    server.close();
    console.log("Server stopped.");
  };

  // Synchronous cleanup for forced exits
  const syncCleanup = () => {
    if (context) {
      try {
        context.close();
      } catch {
        // Best effort
      }
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
    // In lazy mode, wsEndpoint is null until browser launches
    // Callers should use the HTTP API to get wsEndpoint
    wsEndpoint: wsEndpoint ?? `ws://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/devtools/browser/pending`,
    port,
    async stop() {
      removeHandlers();
      await cleanup();
    },
  };
}
