import { describe, expect, it } from "vitest";

import { SecretRedactor } from "./redaction.js";

describe("SecretRedactor", () => {
  it("leaves text unchanged when nothing is registered", () => {
    const redactor = new SecretRedactor();

    expect(redactor.isEmpty).toBe(true);
    expect(redactor.redact("plain output")).toBe("plain output");
  });

  it("replaces raw, JSON-escaped and URI-encoded occurrences", () => {
    const redactor = new SecretRedactor();
    redactor.register("GATE_VALUE", 'Gate "value"&more');

    expect(redactor.redact('typed Gate "value"&more')).toBe("typed [REDACTED:GATE_VALUE]");
    expect(redactor.redact(JSON.stringify({ field: 'Gate "value"&more' }))).toBe(
      '{"field":"[REDACTED:GATE_VALUE]"}'
    );
    expect(redactor.redact("body=Gate%20%22value%22%26more")).toBe("body=[REDACTED:GATE_VALUE]");
  });

  it("prefers the longer value when one registered value contains another", () => {
    const redactor = new SecretRedactor();
    redactor.register("SHORT", "abcd");
    redactor.register("LONG", "abcd-efgh");

    expect(redactor.redact("abcd-efgh and abcd")).toBe("[REDACTED:LONG] and [REDACTED:SHORT]");
  });

  it("replaces the value when a name is registered again", () => {
    const redactor = new SecretRedactor();
    redactor.register("ROTATED", "first-value");
    redactor.register("ROTATED", "second-value");

    expect(redactor.redact("first-value second-value")).toBe("first-value [REDACTED:ROTATED]");
  });

  it("resolves the name only for an exact value match", () => {
    const redactor = new SecretRedactor();
    redactor.register("GATE_VALUE", "exact-value");

    expect(redactor.nameForExactValue("exact-value")).toBe("GATE_VALUE");
    expect(redactor.nameForExactValue("prefix exact-value")).toBeUndefined();
    expect(redactor.nameForExactValue(42)).toBeUndefined();
  });

  it.each([
    ["", "value"],
    ["1STARTS_WITH_DIGIT", "value"],
    ["HAS-DASH", "value"],
    [42, "value"],
  ])("rejects invalid name %j", (name, value) => {
    expect(() => new SecretRedactor().register(name, value)).toThrow(TypeError);
  });

  it.each([[""], [undefined], [123]])("rejects invalid value %j", (value) => {
    expect(() => new SecretRedactor().register("VALID_NAME", value)).toThrow(TypeError);
  });
});
