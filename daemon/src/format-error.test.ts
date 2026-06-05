import { describe, expect, it } from "vitest";

import { formatError } from "./format-error.js";

describe("formatError", () => {
  it("composes a name/message header when the stack has none", () => {
    const error = new Error("QuickJS promise rejected: boom message");
    error.stack = "    at <anonymous> (user-script.js:2:15)";

    const formatted = formatError(error);

    expect(formatted).toContain("Error: QuickJS promise rejected: boom message");
    expect(formatted).toContain("at <anonymous> (user-script.js:2:15)");
  });

  it("does not duplicate the header when the stack already has one", () => {
    const error = new Error("native failure");

    const formatted = formatError(error);

    expect(formatted).toBe(error.stack);
    expect(formatted.indexOf("Error: native failure")).toBe(
      formatted.lastIndexOf("Error: native failure")
    );
  });

  it("falls back to the header when there is no stack", () => {
    const error = new Error("no stack here");
    error.stack = undefined;

    expect(formatError(error)).toBe("Error: no stack here");
  });

  it("returns only the message for script timeouts", () => {
    const error = new Error("Script timed out after 30000ms");
    error.name = "ScriptTimeoutError";

    expect(formatError(error)).toBe("Script timed out after 30000ms");
  });

  it("stringifies non-error values", () => {
    expect(formatError("plain failure")).toBe("plain failure");
  });
});
