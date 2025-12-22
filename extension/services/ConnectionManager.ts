/**
 * ConnectionManager - Manages WebSocket connection to relay server.
 */

import type { Logger } from "../utils/logger";
import type { ExtensionCommandMessage, ExtensionResponseMessage } from "../utils/types";

const RELAY_URL = "ws://localhost:9222/extension";
const RECONNECT_INTERVAL = 3000;

export interface ConnectionManagerDeps {
  logger: Logger;
  onMessage: (message: ExtensionCommandMessage) => Promise<unknown>;
  onDisconnect: () => void;
}

export class ConnectionManager {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private logger: Logger;
  private onMessage: (message: ExtensionCommandMessage) => Promise<unknown>;
  private onDisconnect: () => void;

  constructor(deps: ConnectionManagerDeps) {
    this.logger = deps.logger;
    this.onMessage = deps.onMessage;
    this.onDisconnect = deps.onDisconnect;
  }

  /**
   * Check if connected to relay.
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Send a message to the relay server.
   */
  send(message: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        console.debug("Error sending message:", error);
      }
    }
  }

  /**
   * Start maintaining connection (auto-reconnect).
   */
  startMaintaining(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.tryConnect().catch(() => {});
    this.reconnectTimer = setTimeout(() => this.startMaintaining(), RECONNECT_INTERVAL);
  }

  /**
   * Stop connection maintenance.
   */
  stopMaintaining(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Ensure connection is established, waiting if needed.
   */
  async ensureConnected(): Promise<void> {
    if (this.isConnected()) return;

    await this.tryConnect();

    if (!this.isConnected()) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await this.tryConnect();
    }

    if (!this.isConnected()) {
      throw new Error("Could not connect to relay server");
    }
  }

  /**
   * Try to connect to relay server once.
   */
  private async tryConnect(): Promise<void> {
    if (this.isConnected()) return;

    // Check if server is available
    try {
      await fetch("http://localhost:9222", { method: "HEAD" });
    } catch {
      return;
    }

    this.logger.debug("Connecting to relay server...");
    const socket = new WebSocket(RELAY_URL);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout"));
      }, 5000);

      socket.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };

      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket connection failed"));
      };

      socket.onclose = (event) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket closed: ${event.reason || event.code}`));
      };
    });

    this.ws = socket;
    this.setupSocketHandlers(socket);
    this.logger.log("Connected to relay server");
  }

  /**
   * Set up WebSocket event handlers.
   */
  private setupSocketHandlers(socket: WebSocket): void {
    socket.onmessage = async (event: MessageEvent) => {
      let message: ExtensionCommandMessage;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        this.logger.debug("Error parsing message:", error);
        this.send({
          error: { code: -32700, message: "Parse error" },
        });
        return;
      }

      const response: ExtensionResponseMessage = { id: message.id };
      try {
        response.result = await this.onMessage(message);
      } catch (error) {
        this.logger.debug("Error handling command:", error);
        response.error = (error as Error).message;
      }
      this.send(response);
    };

    socket.onclose = (event: CloseEvent) => {
      this.logger.debug("Connection closed:", event.code, event.reason);
      this.ws = null;
      this.onDisconnect();
      this.startMaintaining();
    };

    socket.onerror = (event: Event) => {
      this.logger.debug("WebSocket error:", event);
    };
  }
}
