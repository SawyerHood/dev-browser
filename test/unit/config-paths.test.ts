import { test, expect, describe, afterEach } from "bun:test";
import * as path from "node:path";
import { parseDuration, formatDuration, resolveIdleTimeoutMs, DEFAULTS } from "../../src/shared/config.ts";
import { jailPath, sanitizeName, sanitizeKey, paths, doobieHome } from "../../src/shared/paths.ts";
import { LineDecoder, encodeFrame } from "../../src/shared/protocol.ts";

describe("parseDuration", () => {
  test("units", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("1500")).toBe(1500);
    expect(parseDuration("1500ms")).toBe(1500);
    expect(parseDuration("0")).toBe(0);
    expect(parseDuration("1.5s")).toBe(1500);
    expect(parseDuration(" 2M ")).toBe(120_000);
    expect(parseDuration(250)).toBe(250);
  });
  test("garbage throws", () => {
    expect(() => parseDuration("abc")).toThrow(/invalid duration/);
    expect(() => parseDuration("-5s")).toThrow();
    expect(() => parseDuration("")).toThrow();
    expect(() => parseDuration(-1)).toThrow();
    expect(() => parseDuration(NaN)).toThrow();
    expect(() => parseDuration("5d")).toThrow();
  });
});

describe("formatDuration", () => {
  test("round-trips nicely", () => {
    expect(formatDuration(0)).toBe("off");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(300_000)).toBe("5m");
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(1500)).toBe("1500ms");
  });
});

describe("resolveIdleTimeoutMs precedence", () => {
  const prev = process.env.DOOBIE_IDLE_TIMEOUT;
  afterEach(() => {
    if (prev === undefined) delete process.env.DOOBIE_IDLE_TIMEOUT;
    else process.env.DOOBIE_IDLE_TIMEOUT = prev;
  });
  test("flag > env > config > default", () => {
    delete process.env.DOOBIE_IDLE_TIMEOUT;
    expect(resolveIdleTimeoutMs(undefined, {})).toBe(DEFAULTS.idleTimeoutMs);
    expect(resolveIdleTimeoutMs(undefined, { idleTimeout: "2m" })).toBe(120_000);
    expect(resolveIdleTimeoutMs(undefined, { idleTimeout: 7000 })).toBe(7000);
    process.env.DOOBIE_IDLE_TIMEOUT = "3m";
    expect(resolveIdleTimeoutMs(undefined, { idleTimeout: "2m" })).toBe(180_000);
    expect(resolveIdleTimeoutMs("1m", { idleTimeout: "2m" })).toBe(60_000);
    expect(resolveIdleTimeoutMs("0", { idleTimeout: "2m" })).toBe(0);
    process.env.DOOBIE_IDLE_TIMEOUT = "";
    expect(resolveIdleTimeoutMs(undefined, { idleTimeout: "2m" })).toBe(120_000);
  });
  test("bad flag throws", () => {
    expect(() => resolveIdleTimeoutMs("soon", {})).toThrow();
  });
});

describe("jailPath", () => {
  test("accepts plain names under the tmp dir", () => {
    expect(jailPath("out.txt")).toBe(path.join(paths.tmp(), "out.txt"));
    expect(jailPath("a-b_c.1.json")).toBe(path.join(paths.tmp(), "a-b_c.1.json"));
  });
  test("rejects escapes", () => {
    expect(() => jailPath("/etc/passwd")).toThrow();
    expect(() => jailPath("../x")).toThrow();
    expect(() => jailPath("..")).toThrow();
    expect(() => jailPath(".")).toThrow();
    expect(() => jailPath("a/b")).toThrow();
    expect(() => jailPath("a\\b")).toThrow();
    expect(() => jailPath("a\0b")).toThrow();
    expect(() => jailPath("")).toThrow();
    expect(() => jailPath("a b")).toThrow();
    expect(() => jailPath("a*b")).toThrow();
    expect(() => jailPath("ü.txt")).toThrow();
    // @ts-expect-error runtime check
    expect(() => jailPath(undefined)).toThrow();
  });
});

describe("sanitizeName / sanitizeKey", () => {
  test("sanitizeName", () => {
    expect(sanitizeName("work")).toBe("work");
    expect(sanitizeName("my profile!")).toBe("my_profile_");
    expect(sanitizeName("../etc")).toBe("__etc");
    expect(sanitizeName("..")).toBe("_");
    expect(sanitizeName("")).toBe("default");
    expect(sanitizeName("a/b")).toBe("a_b");
    expect(sanitizeName("x".repeat(100)).length).toBe(64);
    expect(sanitizeName(".hidden")).toBe("_hidden");
  });
  test("sanitizeKey", () => {
    expect(sanitizeKey("default")).toBe("default");
    expect(sanitizeKey("work:headless")).toBe("work__headless");
    const k = sanitizeKey("cdp:ws://127.0.0.1:9222/devtools/browser/abc");
    expect(k).toMatch(/^k[0-9a-f]+$/);
    expect(sanitizeKey("cdp:ws://127.0.0.1:9222/devtools/browser/abc")).toBe(k);
    expect(sanitizeKey("cdp:ws://127.0.0.1:9222/devtools/browser/abd")).not.toBe(k);
    expect(sanitizeKey("x".repeat(81))).toMatch(/^k[0-9a-f]+$/);
  });
  test("pagesFile uses the sanitized key", () => {
    expect(paths.pagesFile("work:headless")).toBe(path.join(doobieHome(), "pages", "work__headless.json"));
  });
});

describe("LineDecoder", () => {
  test("partial chunks across boundaries", () => {
    const d = new LineDecoder<{ a: number }>();
    expect(d.push('{"a":1}\n{"a"')).toEqual([{ a: 1 }]);
    expect(d.push(':2}\n')).toEqual([{ a: 2 }]);
    expect(d.push("")).toEqual([]);
    expect(d.push(new TextEncoder().encode('{"a":3}\n\n{"a":4}\n'))).toEqual([{ a: 3 }, { a: 4 }]);
  });
  test("blank lines are skipped; incomplete tail is held", () => {
    const d = new LineDecoder();
    expect(d.push("\n  \n")).toEqual([]);
    expect(d.push('{"x":1}')).toEqual([]);
    expect(d.push("\n")).toEqual([{ x: 1 }]);
  });
  test("cap on a single line", () => {
    const d = new LineDecoder(20);
    expect(() => d.push("x".repeat(21))).toThrow(/exceeds 20/);
  });
  test("invalid JSON throws", () => {
    const d = new LineDecoder();
    expect(() => d.push("nope\n")).toThrow();
  });
  test("encodeFrame round-trips", () => {
    const d = new LineDecoder();
    expect(d.push(encodeFrame({ type: "done", exitCode: 0 }))).toEqual([{ type: "done", exitCode: 0 }]);
  });
});
