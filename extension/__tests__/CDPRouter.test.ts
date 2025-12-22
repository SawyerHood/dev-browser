import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { CDPRouter } from "../services/CDPRouter";
import { TabManager } from "../services/TabManager";
import type { Logger } from "../utils/logger";
import type { ExtensionCommandMessage } from "../utils/types";

// Mock chrome.debugger since fakeBrowser doesn't include it
const mockDebuggerSendCommand = vi.fn();

vi.stubGlobal("chrome", {
  ...fakeBrowser,
  debugger: {
    sendCommand: mockDebuggerSendCommand,
    attach: vi.fn(),
    detach: vi.fn(),
    onEvent: { addListener: vi.fn(), hasListener: vi.fn() },
    onDetach: { addListener: vi.fn(), hasListener: vi.fn() },
    getTargets: vi.fn().mockResolvedValue([]),
  },
});

describe("CDPRouter", () => {
  let cdpRouter: CDPRouter;
  let tabManager: TabManager;
  let mockLogger: Logger;
  let mockSendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fakeBrowser.reset();
    mockDebuggerSendCommand.mockReset();

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

    cdpRouter = new CDPRouter({
      logger: mockLogger,
      tabManager,
    });
  });

  describe("handleCommand", () => {
    it("should return early for non-forwardCDPCommand methods", async () => {
      const msg = {
        id: 1,
        method: "someOtherMethod" as const,
        params: { method: "Test.method" },
      };

      // @ts-expect-error - testing invalid method
      const result = await cdpRouter.handleCommand(msg);
      expect(result).toBeUndefined();
    });

    it("should throw error when no tab found for command", async () => {
      const msg: ExtensionCommandMessage = {
        id: 1,
        method: "forwardCDPCommand",
        params: {
          method: "Page.navigate",
          sessionId: "unknown-session",
        },
      };

      await expect(cdpRouter.handleCommand(msg)).rejects.toThrow(
        "No tab found for method Page.navigate"
      );
    });

    it("should find tab by sessionId", async () => {
      tabManager.set(123, {
        sessionId: "session-1",
        targetId: "target-1",
        state: "connected",
      });

      mockDebuggerSendCommand.mockResolvedValue({ result: "ok" });

      const msg: ExtensionCommandMessage = {
        id: 1,
        method: "forwardCDPCommand",
        params: {
          method: "Page.navigate",
          sessionId: "session-1",
          params: { url: "https://example.com" },
        },
      };

      await cdpRouter.handleCommand(msg);

      expect(mockDebuggerSendCommand).toHaveBeenCalledWith(
        { tabId: 123, sessionId: undefined },
        "Page.navigate",
        { url: "https://example.com" }
      );
    });

    it("should find tab via child session", async () => {
      tabManager.set(123, {
        sessionId: "parent-session",
        targetId: "target-1",
        state: "connected",
      });
      tabManager.trackChildSession("child-session", 123);

      mockDebuggerSendCommand.mockResolvedValue({});

      const msg: ExtensionCommandMessage = {
        id: 1,
        method: "forwardCDPCommand",
        params: {
          method: "Runtime.evaluate",
          sessionId: "child-session",
        },
      };

      await cdpRouter.handleCommand(msg);

      expect(mockDebuggerSendCommand).toHaveBeenCalledWith(
        { tabId: 123, sessionId: "child-session" },
        "Runtime.evaluate",
        undefined
      );
    });
  });

  describe("handleDebuggerEvent", () => {
    it("should forward CDP events to relay", () => {
      tabManager.set(123, {
        sessionId: "session-1",
        targetId: "target-1",
        state: "connected",
      });

      const sendMessage = vi.fn();

      cdpRouter.handleDebuggerEvent(
        { tabId: 123 },
        "Page.loadEventFired",
        { timestamp: 12345 },
        sendMessage
      );

      expect(sendMessage).toHaveBeenCalledWith({
        method: "forwardCDPEvent",
        params: {
          sessionId: "session-1",
          method: "Page.loadEventFired",
          params: { timestamp: 12345 },
        },
      });
    });

    it("should track child sessions on Target.attachedToTarget", () => {
      tabManager.set(123, {
        sessionId: "session-1",
        targetId: "target-1",
        state: "connected",
      });

      const sendMessage = vi.fn();

      cdpRouter.handleDebuggerEvent(
        { tabId: 123 },
        "Target.attachedToTarget",
        { sessionId: "new-child-session", targetInfo: {} },
        sendMessage
      );

      expect(tabManager.getParentTabId("new-child-session")).toBe(123);
    });

    it("should untrack child sessions on Target.detachedFromTarget", () => {
      tabManager.set(123, {
        sessionId: "session-1",
        targetId: "target-1",
        state: "connected",
      });
      tabManager.trackChildSession("child-session", 123);

      const sendMessage = vi.fn();

      cdpRouter.handleDebuggerEvent(
        { tabId: 123 },
        "Target.detachedFromTarget",
        { sessionId: "child-session" },
        sendMessage
      );

      expect(tabManager.getParentTabId("child-session")).toBeUndefined();
    });

    it("should ignore events for unknown tabs", () => {
      const sendMessage = vi.fn();

      cdpRouter.handleDebuggerEvent(
        { tabId: 999 },
        "Page.loadEventFired",
        {},
        sendMessage
      );

      expect(sendMessage).not.toHaveBeenCalled();
    });
  });
});
