import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { readDevBrowserTempFile, writeDevBrowserTempFile } from "./temp-files.js";

// Regression test for P2-1: readFile()'s hardcoded UTF-8 decoding silently
// corrupts binary (a screenshot read back becomes replacement chars). The new
// { encoding: "base64" } mode must round-trip raw bytes losslessly.
describe("readDevBrowserTempFile binary mode", () => {
  const fileName = "ergo-binary-read.bin";
  let writtenPath = "";

  afterEach(async () => {
    if (writtenPath) {
      await rm(writtenPath, { force: true });
      writtenPath = "";
    }
  });

  it("round-trips binary bytes losslessly via base64, where utf8 corrupts them", async () => {
    // Non-UTF8 bytes: a PNG signature plus high bytes that utf8 mangles.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80]);
    writtenPath = await writeDevBrowserTempFile(fileName, bytes);

    const base64 = await readDevBrowserTempFile(fileName, { encoding: "base64" });
    expect(Buffer.from(base64, "base64")).toEqual(Buffer.from(bytes));

    // The default (utf8) path does NOT round-trip these bytes — proves the bug
    // the base64 mode fixes.
    const utf8 = await readDevBrowserTempFile(fileName);
    expect(Buffer.from(utf8, "utf8")).not.toEqual(Buffer.from(bytes));
  });

  it("default encoding still returns utf8 text", async () => {
    writtenPath = await writeDevBrowserTempFile(fileName, "hello world");
    expect(await readDevBrowserTempFile(fileName)).toBe("hello world");
  });
});
