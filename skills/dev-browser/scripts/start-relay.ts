/**
 * Start the CDP relay server for Chrome extension mode
 *
 * Usage: npm run start-extension
 */

import { serveRelay } from "@/relay.js";

const PORT = parseInt(process.env.PORT || "9222", 10);
const HOST = process.env.HOST || "0.0.0.0";

async function main() {
  // Security warning for non-localhost binding
  if (HOST !== "127.0.0.1" && HOST !== "localhost") {
    console.warn(
      "\x1b[33m⚠ WARNING: Relay server binding to %s - accessible from network!\x1b[0m",
      HOST
    );
    console.warn(
      "\x1b[33m  Set HOST=127.0.0.1 to restrict to localhost only.\x1b[0m"
    );
  }

  const server = await serveRelay({
    port: PORT,
    host: HOST,
  });

  // Handle shutdown
  const shutdown = async () => {
    console.log("\nShutting down relay server...");
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start relay server:", err);
  process.exit(1);
});
