/**
 * Lightweight HTTP-only client for dev-browser.
 *
 * This client uses only HTTP requests to communicate with the server,
 * eliminating the need for Playwright dependency on the client side.
 * All page operations (navigate, evaluate, snapshot, click, fill) are
 * handled server-side via HTTP endpoints.
 *
 * Benefits:
 * - No Playwright dependency (~170MB savings per agent)
 * - Simpler client implementation
 * - Single CDP connection on server (shared across all clients)
 * - Faster client startup (no heavy imports)
 */

import type {
  GetPageRequest,
  GetPageResponse,
  ListPagesResponse,
  ServerInfoResponse,
  EvaluateResponse,
  SnapshotResponse,
  NavigateResponse,
  SelectRefResponse,
} from "./types";

/** Server mode information */
export interface ServerInfo {
  wsEndpoint: string;
  mode: "launch" | "extension";
  extensionConnected?: boolean;
}

export interface DevBrowserLiteClient {
  /**
   * Get or create a page by name.
   * Returns page info without requiring client-side CDP connection.
   */
  page: (name: string) => Promise<{ name: string; targetId: string }>;

  /** List all page names */
  list: () => Promise<string[]>;

  /** Close a page by name */
  close: (name: string) => Promise<void>;

  /** Navigate a page to a URL */
  navigate: (name: string, url: string, waitUntil?: "load" | "domcontentloaded" | "networkidle") => Promise<NavigateResponse>;

  /** Evaluate JavaScript on a page */
  evaluate: (name: string, expression: string) => Promise<unknown>;

  /** Get AI-friendly ARIA snapshot of a page */
  getAISnapshot: (name: string) => Promise<string>;

  /** Get element info by ref from last snapshot */
  selectRef: (name: string, ref: string) => Promise<SelectRefResponse>;

  /** Click on element by ref */
  click: (name: string, ref: string) => Promise<void>;

  /** Fill input by ref */
  fill: (name: string, ref: string, value: string) => Promise<void>;

  /** Get server information */
  getServerInfo: () => Promise<ServerInfo>;

  /** Disconnect (no-op for HTTP client, but maintains API compatibility) */
  disconnect: () => Promise<void>;
}

/**
 * Connect to a dev-browser server using HTTP-only protocol.
 * This lightweight client doesn't require Playwright.
 */
export async function connectLite(serverUrl = "http://localhost:9222"): Promise<DevBrowserLiteClient> {
  // Helper for JSON requests
  async function jsonRequest<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${serverUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`HTTP ${res.status}: ${error}`);
    }

    return res.json() as Promise<T>;
  }

  return {
    async page(name: string) {
      const result = await jsonRequest<GetPageResponse>("/pages", {
        method: "POST",
        body: JSON.stringify({ name } satisfies GetPageRequest),
      });
      return { name: result.name, targetId: result.targetId };
    },

    async list() {
      const result = await jsonRequest<ListPagesResponse>("/pages");
      return result.pages;
    },

    async close(name: string) {
      await jsonRequest(`/pages/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
    },

    async navigate(name: string, url: string, waitUntil?: "load" | "domcontentloaded" | "networkidle") {
      return jsonRequest<NavigateResponse>(`/pages/${encodeURIComponent(name)}/navigate`, {
        method: "POST",
        body: JSON.stringify({ url, waitUntil }),
      });
    },

    async evaluate(name: string, expression: string) {
      const result = await jsonRequest<EvaluateResponse>(`/pages/${encodeURIComponent(name)}/evaluate`, {
        method: "POST",
        body: JSON.stringify({ expression }),
      });
      if (result.error) {
        throw new Error(result.error);
      }
      return result.result;
    },

    async getAISnapshot(name: string) {
      const result = await jsonRequest<SnapshotResponse>(`/pages/${encodeURIComponent(name)}/snapshot`);
      if (result.error) {
        throw new Error(result.error);
      }
      return result.snapshot;
    },

    async selectRef(name: string, ref: string) {
      return jsonRequest<SelectRefResponse>(`/pages/${encodeURIComponent(name)}/select-ref`, {
        method: "POST",
        body: JSON.stringify({ ref }),
      });
    },

    async click(name: string, ref: string) {
      const result = await jsonRequest<{ success?: boolean; error?: string }>(`/pages/${encodeURIComponent(name)}/click`, {
        method: "POST",
        body: JSON.stringify({ ref }),
      });
      if (result.error) {
        throw new Error(result.error);
      }
    },

    async fill(name: string, ref: string, value: string) {
      const result = await jsonRequest<{ success?: boolean; error?: string }>(`/pages/${encodeURIComponent(name)}/fill`, {
        method: "POST",
        body: JSON.stringify({ ref, value }),
      });
      if (result.error) {
        throw new Error(result.error);
      }
    },

    async getServerInfo() {
      const info = await jsonRequest<ServerInfoResponse & { mode?: string; extensionConnected?: boolean }>("/");
      return {
        wsEndpoint: info.wsEndpoint,
        mode: (info.mode as "launch" | "extension") ?? "launch",
        extensionConnected: info.extensionConnected,
      };
    },

    async disconnect() {
      // No-op for HTTP client - no persistent connection to close
    },
  };
}
