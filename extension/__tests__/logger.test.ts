import { describe, it, expect, beforeEach, vi } from "vitest";
import { createLogger } from "../utils/logger";

describe("createLogger", () => {
  let mockSendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSendMessage = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("log", () => {
    it("should log to console and send message", () => {
      const logger = createLogger(mockSendMessage);
      logger.log("test message", 123);

      expect(console.log).toHaveBeenCalledWith("[dev-browser]", "test message", 123);
      expect(mockSendMessage).toHaveBeenCalledWith({
        method: "log",
        params: {
          level: "log",
          args: ["test message", "123"],
        },
      });
    });
  });

  describe("debug", () => {
    it("should debug to console and send message", () => {
      const logger = createLogger(mockSendMessage);
      logger.debug("debug info");

      expect(console.debug).toHaveBeenCalledWith("[dev-browser]", "debug info");
      expect(mockSendMessage).toHaveBeenCalledWith({
        method: "log",
        params: {
          level: "debug",
          args: ["debug info"],
        },
      });
    });
  });

  describe("error", () => {
    it("should error to console and send message", () => {
      const logger = createLogger(mockSendMessage);
      logger.error("error occurred");

      expect(console.error).toHaveBeenCalledWith("[dev-browser]", "error occurred");
      expect(mockSendMessage).toHaveBeenCalledWith({
        method: "log",
        params: {
          level: "error",
          args: ["error occurred"],
        },
      });
    });
  });

  describe("argument formatting", () => {
    it("should format undefined as string", () => {
      const logger = createLogger(mockSendMessage);
      logger.log(undefined);

      expect(mockSendMessage).toHaveBeenCalledWith({
        method: "log",
        params: {
          level: "log",
          args: ["undefined"],
        },
      });
    });

    it("should format null as string", () => {
      const logger = createLogger(mockSendMessage);
      logger.log(null);

      expect(mockSendMessage).toHaveBeenCalledWith({
        method: "log",
        params: {
          level: "log",
          args: ["null"],
        },
      });
    });

    it("should JSON stringify objects", () => {
      const logger = createLogger(mockSendMessage);
      logger.log({ key: "value" });

      expect(mockSendMessage).toHaveBeenCalledWith({
        method: "log",
        params: {
          level: "log",
          args: ['{"key":"value"}'],
        },
      });
    });

    it("should handle circular objects gracefully", () => {
      const logger = createLogger(mockSendMessage);
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;

      logger.log(circular);

      // Should fall back to String() when JSON.stringify fails
      expect(mockSendMessage).toHaveBeenCalledWith({
        method: "log",
        params: {
          level: "log",
          args: ["[object Object]"],
        },
      });
    });
  });
});
