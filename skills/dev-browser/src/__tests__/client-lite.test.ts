/**
 * Client-lite tests
 *
 * Tests the lightweight HTTP-only client.
 * Mocks fetch to test client logic without requiring a running server.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { connectLite, type DevBrowserLiteClient } from "../client-lite";
import type {
  GetPageResponse,
  ListPagesResponse,
  NavigateResponse,
  EvaluateResponse,
  SnapshotResponse,
  SelectRefResponse,
} from "../types";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockJsonResponse<T>(data: T, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response;
}

function mockErrorResponse(message: string, status = 500): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: message }),
    text: () => Promise.resolve(message),
  } as Response;
}

describe("connectLite", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should return client interface", async () => {
    const client = await connectLite("http://localhost:9222");

    expect(client.page).toBeTypeOf("function");
    expect(client.list).toBeTypeOf("function");
    expect(client.close).toBeTypeOf("function");
    expect(client.navigate).toBeTypeOf("function");
    expect(client.evaluate).toBeTypeOf("function");
    expect(client.getAISnapshot).toBeTypeOf("function");
    expect(client.selectRef).toBeTypeOf("function");
    expect(client.click).toBeTypeOf("function");
    expect(client.fill).toBeTypeOf("function");
    expect(client.getServerInfo).toBeTypeOf("function");
    expect(client.disconnect).toBeTypeOf("function");
  });

  it("should use default server URL", async () => {
    const client = await connectLite();
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse<ListPagesResponse>({ pages: [] })
    );

    await client.list();

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:9222/pages",
      expect.any(Object)
    );
  });

  it("should use custom server URL", async () => {
    const client = await connectLite("http://localhost:9333");
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse<ListPagesResponse>({ pages: [] })
    );

    await client.list();

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:9333/pages",
      expect.any(Object)
    );
  });
});

describe("DevBrowserLiteClient", () => {
  let client: DevBrowserLiteClient;

  beforeEach(async () => {
    mockFetch.mockReset();
    client = await connectLite("http://localhost:9222");
  });

  describe("page()", () => {
    it("should create page via POST /pages", async () => {
      const response: GetPageResponse = {
        wsEndpoint: "ws://localhost:9222",
        name: "test-page",
        targetId: "target-123",
        mode: "launch",
      };
      mockFetch.mockResolvedValueOnce(mockJsonResponse(response));

      const result = await client.page("test-page");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9222/pages",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "test-page" }),
        })
      );
      expect(result.name).toBe("test-page");
      expect(result.targetId).toBe("target-123");
    });
  });

  describe("list()", () => {
    it("should list pages via GET /pages", async () => {
      const response: ListPagesResponse = { pages: ["page1", "page2"] };
      mockFetch.mockResolvedValueOnce(mockJsonResponse(response));

      const result = await client.list();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9222/pages",
        expect.any(Object)
      );
      expect(result).toEqual(["page1", "page2"]);
    });
  });

  describe("close()", () => {
    it("should close page via DELETE /pages/:name", async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ success: true }));

      await client.close("test-page");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9222/pages/test-page",
        expect.objectContaining({ method: "DELETE" })
      );
    });

    it("should encode special characters in page name", async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ success: true }));

      await client.close("page with spaces");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9222/pages/page%20with%20spaces",
        expect.any(Object)
      );
    });
  });

  describe("navigate()", () => {
    it("should navigate via POST /pages/:name/navigate", async () => {
      const response: NavigateResponse = {
        url: "https://example.com",
        title: "Example Domain",
      };
      mockFetch.mockResolvedValueOnce(mockJsonResponse(response));

      const result = await client.navigate("test-page", "https://example.com");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9222/pages/test-page/navigate",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ url: "https://example.com", waitUntil: undefined }),
        })
      );
      expect(result.url).toBe("https://example.com");
      expect(result.title).toBe("Example Domain");
    });

    it("should pass waitUntil option", async () => {
      const response: NavigateResponse = {
        url: "https://example.com",
        title: "Example",
      };
      mockFetch.mockResolvedValueOnce(mockJsonResponse(response));

      await client.navigate("test-page", "https://example.com", "networkidle");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ url: "https://example.com", waitUntil: "networkidle" }),
        })
      );
    });
  });

  describe("evaluate()", () => {
    it("should evaluate via POST /pages/:name/evaluate", async () => {
      const response: EvaluateResponse = { result: "Example Domain" };
      mockFetch.mockResolvedValueOnce(mockJsonResponse(response));

      const result = await client.evaluate("test-page", "document.title");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9222/pages/test-page/evaluate",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ expression: "document.title" }),
        })
      );
      expect(result).toBe("Example Domain");
    });

    it("should throw on evaluation error", async () => {
      const response: EvaluateResponse = {
        result: null,
        error: "ReferenceError: foo is not defined",
      };
      mockFetch.mockResolvedValueOnce(mockJsonResponse(response));

      await expect(client.evaluate("test-page", "foo")).rejects.toThrow(
        "ReferenceError: foo is not defined"
      );
    });
  });

  describe("getAISnapshot()", () => {
    it("should get snapshot via GET /pages/:name/snapshot", async () => {
      const response: SnapshotResponse = {
        snapshot: "- document\n  - heading [ref=e1] 'Example'",
      };
      mockFetch.mockResolvedValueOnce(mockJsonResponse(response));

      const result = await client.getAISnapshot("test-page");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9222/pages/test-page/snapshot",
        expect.any(Object)
      );
      expect(result).toContain("heading");
      expect(result).toContain("ref=e1");
    });

    it("should throw on snapshot error", async () => {
      const response: SnapshotResponse = {
        snapshot: "",
        error: "Page not loaded",
      };
      mockFetch.mockResolvedValueOnce(mockJsonResponse(response));

      await expect(client.getAISnapshot("test-page")).rejects.toThrow("Page not loaded");
    });
  });

  describe("selectRef()", () => {
    it("should select ref via POST /pages/:name/select-ref", async () => {
      const response: SelectRefResponse = {
        found: true,
        tagName: "A",
        textContent: "More information...",
      };
      mockFetch.mockResolvedValueOnce(mockJsonResponse(response));

      const result = await client.selectRef("test-page", "e123");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9222/pages/test-page/select-ref",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ ref: "e123" }),
        })
      );
      expect(result.found).toBe(true);
      expect(result.tagName).toBe("A");
    });

    it("should handle ref not found", async () => {
      const response: SelectRefResponse = { found: false };
      mockFetch.mockResolvedValueOnce(mockJsonResponse(response));

      const result = await client.selectRef("test-page", "e999");

      expect(result.found).toBe(false);
      expect(result.tagName).toBeUndefined();
    });
  });

  describe("click()", () => {
    it("should click via POST /pages/:name/click", async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ success: true }));

      await client.click("test-page", "e123");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9222/pages/test-page/click",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ ref: "e123" }),
        })
      );
    });

    it("should throw on click error", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ error: 'Ref "e999" not found' })
      );

      await expect(client.click("test-page", "e999")).rejects.toThrow(
        'Ref "e999" not found'
      );
    });
  });

  describe("fill()", () => {
    it("should fill via POST /pages/:name/fill", async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ success: true }));

      await client.fill("test-page", "e123", "test value");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9222/pages/test-page/fill",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ ref: "e123", value: "test value" }),
        })
      );
    });

    it("should throw on fill error", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ error: "Element is not fillable" })
      );

      await expect(client.fill("test-page", "e123", "value")).rejects.toThrow(
        "Element is not fillable"
      );
    });
  });

  describe("getServerInfo()", () => {
    it("should get server info via GET /", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          wsEndpoint: "ws://localhost:9222",
          mode: "extension",
          extensionConnected: true,
        })
      );

      const result = await client.getServerInfo();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9222/",
        expect.any(Object)
      );
      expect(result.wsEndpoint).toBe("ws://localhost:9222");
      expect(result.mode).toBe("extension");
      expect(result.extensionConnected).toBe(true);
    });

    it("should default to launch mode", async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ wsEndpoint: "ws://localhost:9222" })
      );

      const result = await client.getServerInfo();

      expect(result.mode).toBe("launch");
    });
  });

  describe("disconnect()", () => {
    it("should be a no-op for HTTP client", async () => {
      // disconnect() should not throw and not make any HTTP requests
      await expect(client.disconnect()).resolves.toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should throw on HTTP error response", async () => {
      mockFetch.mockResolvedValueOnce(mockErrorResponse("page not found", 404));

      await expect(client.list()).rejects.toThrow("HTTP 404");
    });

    it("should throw on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await expect(client.list()).rejects.toThrow("ECONNREFUSED");
    });
  });
});
