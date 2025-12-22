/**
 * Logger utility for the dev-browser extension.
 * Logs to console and optionally sends to relay server.
 */

export type LogLevel = "log" | "debug" | "error";

export interface LogMessage {
  method: "log";
  params: {
    level: LogLevel;
    args: string[];
  };
}

export type SendMessageFn = (message: unknown) => void;

/**
 * Creates a logger instance that logs to console and sends to relay.
 */
export function createLogger(sendMessage: SendMessageFn) {
  function formatArgs(args: unknown[]): string[] {
    return args.map((arg) => {
      if (arg === undefined) return "undefined";
      if (arg === null) return "null";
      if (typeof arg === "object") {
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    });
  }

  function sendLog(level: LogLevel, args: unknown[]): void {
    sendMessage({
      method: "log",
      params: {
        level,
        args: formatArgs(args),
      },
    });
  }

  return {
    log: (...args: unknown[]) => {
      console.log("[dev-browser]", ...args);
      sendLog("log", args);
    },
    debug: (...args: unknown[]) => {
      console.debug("[dev-browser]", ...args);
      sendLog("debug", args);
    },
    error: (...args: unknown[]) => {
      console.error("[dev-browser]", ...args);
      sendLog("error", args);
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
