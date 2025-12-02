import { chromium, type BrowserServer } from "playwright";

export interface ServeOptions {
  port?: number;
  headless?: boolean;
}

export interface DevBrowserServer {
  wsEndpoint: string;
  stop: () => Promise<void>;
}

export async function serve(
  options: ServeOptions = {}
): Promise<DevBrowserServer> {
  const port = options.port ?? 9222;
  const headless = options.headless ?? false;

  console.log("Launching browser server...");

  // Launch browser server - clients connect directly via WebSocket
  const browserServer: BrowserServer = await chromium.launchServer({
    headless,
    port,
  });

  const wsEndpoint = browserServer.wsEndpoint();
  console.log(`Browser server started at: ${wsEndpoint}`);

  // Cleanup function to close the browser server
  const cleanup = async () => {
    console.log("\nShutting down browser server...");
    await browserServer.close();
    console.log("Browser server stopped.");
    process.exit(0);
  };

  // Register signal handlers to ensure browser server is cleaned up on process exit
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);

  return {
    wsEndpoint,
    async stop() {
      // Remove signal handlers when manually stopped to avoid double cleanup
      process.off("SIGINT", cleanup);
      process.off("SIGTERM", cleanup);
      process.off("SIGHUP", cleanup);
      await browserServer.close();
    },
  };
}
