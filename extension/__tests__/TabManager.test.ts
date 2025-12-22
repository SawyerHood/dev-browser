import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { TabManager } from "../services/TabManager";
import type { Logger } from "../utils/logger";

describe("TabManager", () => {
  let tabManager: TabManager;
  let mockLogger: Logger;
  let mockSendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fakeBrowser.reset();

    mockLogger = {
      log: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };

    mockSendMessage = vi.fn();

    tabManager = new TabManager({
      logger: mockLogger,
      sendMessage: mockSendMessage,
    });
  });

  describe("getBySessionId", () => {
    it("should return undefined when no tabs exist", () => {
      const result = tabManager.getBySessionId("session-1");
      expect(result).toBeUndefined();
    });

    it("should find tab by session ID", () => {
      tabManager.set(123, {
        sessionId: "session-1",
        targetId: "target-1",
        state: "connected",
      });

      const result = tabManager.getBySessionId("session-1");
      expect(result).toEqual({
        tabId: 123,
        tab: {
          sessionId: "session-1",
          targetId: "target-1",
          state: "connected",
        },
      });
    });
  });

  describe("getByTargetId", () => {
    it("should return undefined when no tabs exist", () => {
      const result = tabManager.getByTargetId("target-1");
      expect(result).toBeUndefined();
    });

    it("should find tab by target ID", () => {
      tabManager.set(456, {
        sessionId: "session-2",
        targetId: "target-2",
        state: "connected",
      });

      const result = tabManager.getByTargetId("target-2");
      expect(result).toEqual({
        tabId: 456,
        tab: {
          sessionId: "session-2",
          targetId: "target-2",
          state: "connected",
        },
      });
    });
  });

  describe("child sessions", () => {
    it("should track child sessions", () => {
      tabManager.trackChildSession("child-session-1", 123);
      expect(tabManager.getParentTabId("child-session-1")).toBe(123);
    });

    it("should untrack child sessions", () => {
      tabManager.trackChildSession("child-session-1", 123);
      tabManager.untrackChildSession("child-session-1");
      expect(tabManager.getParentTabId("child-session-1")).toBeUndefined();
    });
  });

  describe("set/get/has", () => {
    it("should set and get tab info", () => {
      tabManager.set(789, { state: "connecting" });
      expect(tabManager.get(789)).toEqual({ state: "connecting" });
      expect(tabManager.has(789)).toBe(true);
    });

    it("should return undefined for unknown tabs", () => {
      expect(tabManager.get(999)).toBeUndefined();
      expect(tabManager.has(999)).toBe(false);
    });
  });

  describe("detach", () => {
    it("should send detached event and remove tab", () => {
      tabManager.set(123, {
        sessionId: "session-1",
        targetId: "target-1",
        state: "connected",
      });

      tabManager.detach(123, false);

      expect(mockSendMessage).toHaveBeenCalledWith({
        method: "forwardCDPEvent",
        params: {
          method: "Target.detachedFromTarget",
          params: { sessionId: "session-1", targetId: "target-1" },
        },
      });

      expect(tabManager.has(123)).toBe(false);
    });

    it("should clean up child sessions when detaching", () => {
      tabManager.set(123, {
        sessionId: "session-1",
        targetId: "target-1",
        state: "connected",
      });
      tabManager.trackChildSession("child-1", 123);
      tabManager.trackChildSession("child-2", 123);

      tabManager.detach(123, false);

      expect(tabManager.getParentTabId("child-1")).toBeUndefined();
      expect(tabManager.getParentTabId("child-2")).toBeUndefined();
    });

    it("should do nothing for unknown tabs", () => {
      tabManager.detach(999, false);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe("clear", () => {
    it("should clear all tabs and child sessions", () => {
      tabManager.set(1, { state: "connected" });
      tabManager.set(2, { state: "connected" });
      tabManager.trackChildSession("child-1", 1);

      tabManager.clear();

      expect(tabManager.has(1)).toBe(false);
      expect(tabManager.has(2)).toBe(false);
      expect(tabManager.getParentTabId("child-1")).toBeUndefined();
    });
  });

  describe("getAllTabIds", () => {
    it("should return all tab IDs", () => {
      tabManager.set(1, { state: "connected" });
      tabManager.set(2, { state: "connecting" });
      tabManager.set(3, { state: "error" });

      const ids = tabManager.getAllTabIds();
      expect(ids).toEqual([1, 2, 3]);
    });
  });
});
