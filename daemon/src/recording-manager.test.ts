import { readFile, rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { generateTest } from "./recording-manager.js";
import { SecretRedactor } from "./redaction.js";

const typedValue = "Gate-Value-123";

function recordedLog() {
  return [
    {
      kind: "page-action",
      action: "goto",
      args: [`https://dev.example.test/login?hint=${typedValue}`],
      timestamp: 0,
    },
    {
      kind: "locator-action",
      chain: [{ method: "getByLabel", args: ["Heslo"] }],
      action: "fill",
      args: [typedValue],
      timestamp: 10,
    },
    {
      kind: "locator-action",
      chain: [{ method: "getByRole", args: ["textbox", { name: typedValue }] }],
      action: "fill",
      args: [`prefix ${typedValue}`],
      timestamp: 20,
    },
    {
      kind: "checkpoint",
      description: `Logged in with ${typedValue}`,
      url: `https://dev.example.test/home?echo=${typedValue}`,
      title: "Home",
      timestamp: 30,
    },
  ];
}

describe("generateTest redaction", () => {
  const writtenFiles: string[] = [];

  afterEach(async () => {
    await Promise.all(writtenFiles.map((filePath) => rm(filePath, { force: true })));
    writtenFiles.length = 0;
  });

  it("keeps recorded values when no redactor is given", async () => {
    const result = await generateTest(recordedLog(), {});

    expect(result.code).toContain(`.fill("${typedValue}")`);
  });

  it("turns an exact fill value into an env reference and masks partial occurrences", async () => {
    const redactor = new SecretRedactor();
    redactor.register("GATE_VALUE", typedValue);

    const result = await generateTest(
      recordedLog(),
      { testName: `Login ${typedValue}`, outputFile: "redaction-unit.spec.ts" },
      redactor
    );
    if (result.filePath) {
      writtenFiles.push(result.filePath);
    }

    expect(result.code).not.toContain(typedValue);
    expect(result.code).toContain('getByLabel("Heslo").fill(process.env.GATE_VALUE!)');
    expect(result.code).toContain('.fill("prefix [REDACTED:GATE_VALUE]")');
    expect(result.code).toContain('{"name":"[REDACTED:GATE_VALUE]"}');
    expect(result.code).toContain("hint=[REDACTED:GATE_VALUE]");
    expect(result.code).toContain("// Logged in with [REDACTED:GATE_VALUE]");
    expect(result.code).toContain('test.describe("Login [REDACTED:GATE_VALUE]"');
    expect(result.filePath).toBeDefined();
    expect(await readFile(result.filePath!, "utf8")).toBe(result.code);
  });
});
