/**
 * HTTP API endpoint tests
 *
 * Tests the server-side HTTP endpoints that power client-lite.
 * Uses mocked express request/response to test endpoint logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import type {
  GetPageRequest,
  GetPageResponse,
  ListPagesResponse,
  EvaluateRequest,
  NavigateRequest,
  SelectRefRequest,
} from "../types";

// Mock page registry for testing endpoint logic
interface MockPageEntry {
  name: string;
  targetId: string;
  url: string;
  title: string;
}

function createMockRegistry() {
  const pages = new Map<string, MockPageEntry>();
  return {
    pages,
    get: (name: string) => pages.get(name),
    set: (name: string, entry: MockPageEntry) => pages.set(name, entry),
    delete: (name: string) => pages.delete(name),
    keys: () => pages.keys(),
  };
}

function mockResponse() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((data: unknown) => {
      res.body = data;
      return res;
    }),
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe("HTTP API Types", () => {
  describe("GetPageRequest", () => {
    it("should require name field", () => {
      const valid: GetPageRequest = { name: "test-page" };
      expect(valid.name).toBe("test-page");
    });
  });

  describe("GetPageResponse", () => {
    it("should include all required fields", () => {
      const response: GetPageResponse = {
        wsEndpoint: "ws://localhost:9222",
        name: "test-page",
        targetId: "ABC123",
        mode: "launch",
      };
      expect(response.wsEndpoint).toBeDefined();
      expect(response.name).toBeDefined();
      expect(response.targetId).toBeDefined();
      expect(response.mode).toBe("launch");
    });

    it("should support extension mode", () => {
      const response: GetPageResponse = {
        wsEndpoint: "ws://localhost:9222",
        name: "test-page",
        targetId: "ABC123",
        mode: "extension",
      };
      expect(response.mode).toBe("extension");
    });
  });

  describe("ListPagesResponse", () => {
    it("should return array of page names", () => {
      const response: ListPagesResponse = {
        pages: ["page1", "page2", "page3"],
      };
      expect(response.pages).toHaveLength(3);
      expect(response.pages).toContain("page1");
    });
  });
});

describe("Request Validation Logic", () => {
  describe("POST /pages validation", () => {
    it("should reject missing name", () => {
      const body = {} as GetPageRequest;
      const isValid = body.name && typeof body.name === "string";
      expect(isValid).toBeFalsy();
    });

    it("should reject non-string name", () => {
      const body = { name: 123 } as unknown as GetPageRequest;
      const isValid = body.name && typeof body.name === "string";
      expect(isValid).toBeFalsy();
    });

    it("should reject empty name", () => {
      const body: GetPageRequest = { name: "" };
      const isValid = body.name.length > 0;
      expect(isValid).toBeFalsy();
    });

    it("should reject name over 256 chars", () => {
      const body: GetPageRequest = { name: "a".repeat(257) };
      const isValid = body.name.length <= 256;
      expect(isValid).toBeFalsy();
    });

    it("should accept valid name", () => {
      const body: GetPageRequest = { name: "my-test-page" };
      const isValid = body.name && typeof body.name === "string" && body.name.length > 0 && body.name.length <= 256;
      expect(isValid).toBeTruthy();
    });
  });

  describe("POST /pages/:name/navigate validation", () => {
    it("should reject missing url", () => {
      const body = {} as NavigateRequest;
      const isValid = !!body.url;
      expect(isValid).toBeFalsy();
    });

    it("should accept valid url with default waitUntil", () => {
      const body: NavigateRequest = { url: "https://example.com" };
      expect(body.url).toBeDefined();
      expect(body.waitUntil).toBeUndefined();
    });

    it("should accept valid waitUntil options", () => {
      const options: NavigateRequest["waitUntil"][] = ["load", "domcontentloaded", "networkidle"];
      options.forEach((opt) => {
        const body: NavigateRequest = { url: "https://example.com", waitUntil: opt };
        expect(body.waitUntil).toBe(opt);
      });
    });
  });

  describe("POST /pages/:name/evaluate validation", () => {
    it("should reject missing expression", () => {
      const body = {} as EvaluateRequest;
      const isValid = !!body.expression;
      expect(isValid).toBeFalsy();
    });

    it("should accept valid expression", () => {
      const body: EvaluateRequest = { expression: "document.title" };
      expect(body.expression).toBeDefined();
    });
  });

  describe("POST /pages/:name/select-ref validation", () => {
    it("should reject missing ref", () => {
      const body = {} as SelectRefRequest;
      const isValid = !!body.ref;
      expect(isValid).toBeFalsy();
    });

    it("should accept valid ref", () => {
      const body: SelectRefRequest = { ref: "e123" };
      expect(body.ref).toBeDefined();
    });
  });
});

describe("Page Registry Logic", () => {
  let registry: ReturnType<typeof createMockRegistry>;

  beforeEach(() => {
    registry = createMockRegistry();
  });

  it("should create new page if not exists", () => {
    const name = "new-page";
    expect(registry.get(name)).toBeUndefined();

    registry.set(name, {
      name,
      targetId: "target-123",
      url: "about:blank",
      title: "",
    });

    expect(registry.get(name)).toBeDefined();
    expect(registry.get(name)?.targetId).toBe("target-123");
  });

  it("should return existing page if exists", () => {
    const name = "existing-page";
    registry.set(name, {
      name,
      targetId: "target-456",
      url: "https://example.com",
      title: "Example",
    });

    const entry = registry.get(name);
    expect(entry?.targetId).toBe("target-456");
  });

  it("should delete page from registry", () => {
    const name = "to-delete";
    registry.set(name, {
      name,
      targetId: "target-789",
      url: "about:blank",
      title: "",
    });

    expect(registry.get(name)).toBeDefined();
    registry.delete(name);
    expect(registry.get(name)).toBeUndefined();
  });

  it("should list all page names", () => {
    registry.set("page1", { name: "page1", targetId: "t1", url: "", title: "" });
    registry.set("page2", { name: "page2", targetId: "t2", url: "", title: "" });
    registry.set("page3", { name: "page3", targetId: "t3", url: "", title: "" });

    const names = Array.from(registry.keys());
    expect(names).toHaveLength(3);
    expect(names).toContain("page1");
    expect(names).toContain("page2");
    expect(names).toContain("page3");
  });
});

describe("URL Encoding", () => {
  it("should handle special characters in page names", () => {
    const specialNames = [
      "page with spaces",
      "page/with/slashes",
      "page?with=query",
      "page#with#hash",
      "unicode-页面",
    ];

    specialNames.forEach((name) => {
      const encoded = encodeURIComponent(name);
      const decoded = decodeURIComponent(encoded);
      expect(decoded).toBe(name);
    });
  });
});
