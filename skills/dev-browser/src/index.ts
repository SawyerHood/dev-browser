import express, { type Express, type Request, type Response } from "express";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";
import type { Socket } from "net";
import type {
  ServeOptions,
  GetPageRequest,
  GetPageResponse,
  ListPagesResponse,
  ServerInfoResponse,
  RecordingOptions,
  StartRecordingRequest,
  StartRecordingResponse,
  StopRecordingResponse,
  RecordingStatusResponse,
  GetVideoPathResponse,
} from "./types";
import { encodeFramesToVideo } from "./video-encoder";

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
  const headless = options.headless ?? false;
  const cdpPort = options.cdpPort ?? 9223;
  const profileDir = options.profileDir;
  const recordingsDir = options.recordingsDir ?? join(process.cwd(), "recordings");

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

  // Create directories if they don't exist
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(recordingsDir, { recursive: true });
  console.log(`Using persistent browser profile: ${userDataDir}`);
  console.log(`Recordings directory: ${recordingsDir}`);

  console.log("Launching browser with persistent context...");

  // Build context options
  const contextOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless,
    args: [`--remote-debugging-port=${cdpPort}`],
  };

  // Add Playwright recordVideo if enabled
  if (options.recordVideo) {
    mkdirSync(options.recordVideo.dir, { recursive: true });
    contextOptions.recordVideo = {
      dir: options.recordVideo.dir,
      size: options.recordVideo.size,
    };
    console.log(`Playwright video recording enabled: ${options.recordVideo.dir}`);
  }

  // Launch persistent context - this persists cookies, localStorage, cache, etc.
  const context: BrowserContext = await chromium.launchPersistentContext(
    userDataDir,
    contextOptions
  );
  console.log("Browser launched with persistent profile...");

  // Get the CDP WebSocket endpoint from Chrome's JSON API (with retry for slow startup)
  const cdpResponse = await fetchWithRetry(`http://127.0.0.1:${cdpPort}/json/version`);
  const cdpInfo = (await cdpResponse.json()) as { webSocketDebuggerUrl: string };
  const wsEndpoint = cdpInfo.webSocketDebuggerUrl;
  console.log(`CDP WebSocket endpoint: ${wsEndpoint}`);

  // Recording state for a page
  interface RecordingState {
    isRecording: boolean;
    startedAt: Date;
    frameCount: number;
    cdpSession: CDPSession;
    frameBuffer: Buffer[];
    options: RecordingOptions;
    outputPath: string;
  }

  // Registry entry type for page tracking
  interface PageEntry {
    page: Page;
    targetId: string;
    recording?: RecordingState;
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
    const { name, viewport } = body;

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

      // Apply viewport if provided
      if (viewport) {
        await page.setViewportSize(viewport);
      }

      const targetId = await getTargetId(page);
      entry = { page, targetId };
      registry.set(name, entry);

      // Clean up registry when page is closed (e.g., user clicks X)
      page.on("close", () => {
        registry.delete(name);
      });
    }

    const response: GetPageResponse = { wsEndpoint, name, targetId: entry.targetId };
    res.json(response);
  });

  // DELETE /pages/:name - close a page
  app.delete("/pages/:name", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (entry) {
      // Stop any active recording first
      if (entry.recording?.isRecording) {
        try {
          await entry.recording.cdpSession.send("Page.stopScreencast");
          await entry.recording.cdpSession.detach();
        } catch {
          // Ignore errors during cleanup
        }
      }
      await entry.page.close();
      registry.delete(name);
      res.json({ success: true });
      return;
    }

    res.status(404).json({ error: "page not found" });
  });

  // === Recording Endpoints ===

  // GET /pages/:name/recording/status - check recording status
  app.get(
    "/pages/:name/recording/status",
    (req: Request<{ name: string }>, res: Response) => {
      const name = decodeURIComponent(req.params.name);
      const entry = registry.get(name);

      if (!entry) {
        res.status(404).json({ error: "page not found" });
        return;
      }

      const response: RecordingStatusResponse = {
        isRecording: entry.recording?.isRecording ?? false,
        startedAt: entry.recording?.startedAt?.toISOString(),
        frameCount: entry.recording?.frameCount,
      };
      res.json(response);
    }
  );

  // POST /pages/:name/recording/start - start CDP screencast recording
  app.post(
    "/pages/:name/recording/start",
    async (req: Request<{ name: string }>, res: Response) => {
      const name = decodeURIComponent(req.params.name);
      const body = req.body as StartRecordingRequest;
      const entry = registry.get(name);

      if (!entry) {
        res.status(404).json({ error: "page not found" });
        return;
      }

      if (entry.recording?.isRecording) {
        const response: StartRecordingResponse = {
          success: false,
          error: "Recording already in progress",
        };
        res.status(409).json(response);
        return;
      }

      try {
        const recordingOptions: RecordingOptions = {
          maxWidth: body.options?.maxWidth ?? 1280,
          maxHeight: body.options?.maxHeight ?? 720,
          quality: body.options?.quality ?? 80,
          everyNthFrame: body.options?.everyNthFrame ?? 1,
        };

        // Create CDP session for this page
        const cdpSession = await context.newCDPSession(entry.page);

        // Generate output path
        const timestamp = Date.now();
        const safeName = name.replace(/[^a-zA-Z0-9-_]/g, "_");
        const outputPath = join(recordingsDir, `${safeName}-${timestamp}.webm`);

        // Initialize recording state
        entry.recording = {
          isRecording: true,
          startedAt: new Date(),
          frameCount: 0,
          cdpSession,
          frameBuffer: [],
          options: recordingOptions,
          outputPath,
        };

        // Set up frame handler
        cdpSession.on("Page.screencastFrame", async (params) => {
          if (!entry.recording?.isRecording) return;

          // Acknowledge frame to receive next one
          try {
            await cdpSession.send("Page.screencastFrameAck", {
              sessionId: params.sessionId,
            });
          } catch {
            // Session might be closed
            return;
          }

          // Store frame
          const frameData = Buffer.from(params.data, "base64");
          entry.recording.frameBuffer.push(frameData);
          entry.recording.frameCount++;
        });

        // Start screencast
        await cdpSession.send("Page.startScreencast", {
          format: "jpeg",
          quality: recordingOptions.quality,
          maxWidth: recordingOptions.maxWidth,
          maxHeight: recordingOptions.maxHeight,
          everyNthFrame: recordingOptions.everyNthFrame,
        });

        const response: StartRecordingResponse = { success: true };
        res.json(response);
      } catch (err) {
        entry.recording = undefined;
        const response: StartRecordingResponse = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
        res.status(500).json(response);
      }
    }
  );

  // POST /pages/:name/recording/stop - stop recording and encode video
  app.post(
    "/pages/:name/recording/stop",
    async (req: Request<{ name: string }>, res: Response) => {
      const name = decodeURIComponent(req.params.name);
      const entry = registry.get(name);

      if (!entry) {
        res.status(404).json({ error: "page not found" });
        return;
      }

      if (!entry.recording?.isRecording) {
        const response: StopRecordingResponse = {
          success: false,
          error: "No recording in progress",
        };
        res.status(409).json(response);
        return;
      }

      try {
        const recording = entry.recording;
        recording.isRecording = false;

        // Stop screencast
        try {
          await recording.cdpSession.send("Page.stopScreencast");
          await recording.cdpSession.detach();
        } catch {
          // Session might already be closed
        }

        // Calculate duration
        const durationMs = Date.now() - recording.startedAt.getTime();
        const frameCount = recording.frameCount;

        // Encode frames to video
        let videoPath: string;
        if (recording.frameBuffer.length > 0) {
          videoPath = await encodeFramesToVideo(
            recording.frameBuffer,
            recording.outputPath,
            { fps: 30, format: "webm" }
          );
        } else {
          videoPath = recording.outputPath;
        }

        // Clean up recording state
        entry.recording = undefined;

        const response: StopRecordingResponse = {
          success: true,
          videoPath,
          durationMs,
          frameCount,
        };
        res.json(response);
      } catch (err) {
        entry.recording = undefined;
        const response: StopRecordingResponse = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
        res.status(500).json(response);
      }
    }
  );

  // GET /pages/:name/video - get Playwright recordVideo path
  app.get(
    "/pages/:name/video",
    async (req: Request<{ name: string }>, res: Response) => {
      const name = decodeURIComponent(req.params.name);
      const entry = registry.get(name);

      if (!entry) {
        res.status(404).json({ error: "page not found" });
        return;
      }

      if (!options.recordVideo) {
        const response: GetVideoPathResponse = {
          pending: false,
          error: "Server not started with recordVideo option",
        };
        res.json(response);
        return;
      }

      try {
        const video = entry.page.video();
        if (!video) {
          const response: GetVideoPathResponse = {
            pending: false,
            error: "No video for this page",
          };
          res.json(response);
          return;
        }

        // video.path() throws if video is still being written
        try {
          const videoPath = await video.path();
          const response: GetVideoPathResponse = { videoPath, pending: false };
          res.json(response);
        } catch {
          const response: GetVideoPathResponse = { pending: true };
          res.json(response);
        }
      } catch (err) {
        const response: GetVideoPathResponse = {
          pending: false,
          error: err instanceof Error ? err.message : String(err),
        };
        res.json(response);
      }
    }
  );

  // Start the server
  const server = app.listen(port, () => {
    console.log(`HTTP API server running on port ${port}`);
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

    // Close all pages (stop recordings first)
    for (const entry of registry.values()) {
      try {
        // Stop any active recording
        if (entry.recording?.isRecording) {
          try {
            await entry.recording.cdpSession.send("Page.stopScreencast");
            await entry.recording.cdpSession.detach();
          } catch {
            // Ignore recording cleanup errors
          }
        }
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
    console.log("Server stopped.");
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
