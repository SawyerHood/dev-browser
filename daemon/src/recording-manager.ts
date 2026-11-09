import path from "node:path";
import type { SecretRedactor } from "./redaction.js";
import { writeDevBrowserTempFile } from "./temp-files.js";

type LocatorChainStep = { method: string; args: unknown[] };

type PageActionEntry = {
  kind: "page-action";
  action: string;
  args: unknown[];
  timestamp: number;
};

type LocatorActionEntry = {
  kind: "locator-action";
  chain: LocatorChainStep[];
  action: string;
  args: unknown[];
  timestamp: number;
};

type CheckpointEntry = {
  kind: "checkpoint";
  description: string;
  url: string;
  title: string;
  timestamp: number;
};

type RecordingEntry = PageActionEntry | LocatorActionEntry | CheckpointEntry;

interface RecordingOptions {
  testName?: string;
  outputFile?: string;
}

export interface TestOutput {
  code: string;
  filePath?: string;
  stats: {
    actions: number;
    assertions: number;
    duration: number;
  };
}

class EnvReference {
  constructor(readonly name: string) {}
}

function redactNested(value: unknown, redactor: SecretRedactor): unknown {
  if (typeof value === "string") return redactor.redact(value);
  if (Array.isArray(value)) return value.map((item) => redactNested(item, redactor));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactNested(item, redactor)])
    );
  }
  return value;
}

function redactArg(arg: unknown, redactor: SecretRedactor): unknown {
  const name = redactor.nameForExactValue(arg);
  return name === undefined ? redactNested(arg, redactor) : new EnvReference(name);
}

function redactEntry(entry: RecordingEntry, redactor: SecretRedactor): RecordingEntry {
  const redactArgs = (args: unknown[]) => args.map((arg) => redactArg(arg, redactor));
  switch (entry.kind) {
    case "checkpoint":
      return {
        ...entry,
        description: redactor.redact(entry.description),
        url: redactor.redact(entry.url),
        title: redactor.redact(entry.title),
      };
    case "page-action":
      return { ...entry, args: redactArgs(entry.args) };
    case "locator-action":
      return {
        ...entry,
        args: redactArgs(entry.args),
        chain: entry.chain.map((step) => ({ ...step, args: redactArgs(step.args) })),
      };
  }
}

function formatArg(arg: unknown): string {
  if (arg instanceof EnvReference) return `process.env.${arg.name}!`;
  if (arg === null) return "null";
  if (arg === undefined) return "undefined";
  if (typeof arg === "string") return JSON.stringify(arg);
  if (typeof arg === "number" || typeof arg === "boolean") return String(arg);
  if (typeof arg === "object") {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

function formatArgs(args: unknown[]): string {
  return args.map(formatArg).join(", ");
}

function buildLocatorChain(chain: LocatorChainStep[]): string {
  return chain.map(({ method, args }) => `${method}(${formatArgs(args)})`).join(".");
}

function generateUrlPattern(url: string): string {
  try {
    const parsed = new URL(url);
    const pathSegment = parsed.pathname;
    if (pathSegment && pathSegment !== "/") {
      return `/${pathSegment.replace(/^\//, "")}/`;
    }
  } catch {
    // Not a valid URL
  }
  return JSON.stringify(url);
}

function generateCheckpointAssertions(entry: CheckpointEntry, indent: string): string {
  const lines: string[] = [];
  lines.push(`${indent}// ${entry.description}`);

  if (entry.url) {
    const urlPattern = generateUrlPattern(entry.url);
    if (urlPattern.startsWith("/")) {
      lines.push(`${indent}await expect(page).toHaveURL(${urlPattern});`);
    } else {
      lines.push(`${indent}await expect(page).toHaveURL(${urlPattern});`);
    }
  }

  if (entry.title && entry.title.length > 0) {
    lines.push(`${indent}await expect(page).toHaveTitle(${JSON.stringify(entry.title)});`);
  }

  return lines.join("\n");
}

function generateActionCode(entry: RecordingEntry, indent: string): string {
  if (entry.kind === "checkpoint") {
    return generateCheckpointAssertions(entry, indent);
  }

  if (entry.kind === "page-action") {
    const argsStr = formatArgs(entry.args);
    if (entry.action === "goto" && entry.args.length > 0) {
      return `${indent}await page.goto(${argsStr});`;
    }
    if (entry.action === "screenshot") {
      return `${indent}// await page.screenshot(${argsStr}); // screenshot during recording`;
    }
    return `${indent}await page.${entry.action}(${argsStr});`;
  }

  if (entry.kind === "locator-action") {
    const chainStr = buildLocatorChain(entry.chain);
    const argsStr = formatArgs(entry.args);
    return `${indent}await page.${chainStr}.${entry.action}(${argsStr});`;
  }

  return "";
}

export async function generateTest(
  log: unknown,
  options: unknown,
  redactor?: SecretRedactor
): Promise<TestOutput> {
  const recordedEntries = (Array.isArray(log) ? log : []) as RecordingEntry[];
  const entries = redactor
    ? recordedEntries.map((entry) => redactEntry(entry, redactor))
    : recordedEntries;
  const opts = (options ?? {}) as RecordingOptions;
  const recordedTestName = opts.testName ?? "Recorded test";
  const testName = redactor ? redactor.redact(recordedTestName) : recordedTestName;
  const outputFile = opts.outputFile;

  const actionCount = entries.filter(
    (e) => e.kind === "page-action" || e.kind === "locator-action",
  ).length;
  const assertionCount = entries.filter((e) => e.kind === "checkpoint").length;
  const timestamps = entries.map((e) => e.timestamp).filter((t) => typeof t === "number");
  const duration =
    timestamps.length >= 2
      ? (timestamps[timestamps.length - 1] ?? 0) - (timestamps[0] ?? 0)
      : 0;

  const indent = "    ";
  const lines: string[] = [
    `// Generated by dev-browser recorder`,
    `// Session: ${new Date().toISOString()}`,
    ``,
    `import { test, expect } from "@playwright/test";`,
    ``,
    `test.describe(${JSON.stringify(testName)}, () => {`,
    `  test("should complete successfully", async ({ page }) => {`,
  ];

  for (const entry of entries) {
    const code = generateActionCode(entry, indent);
    if (code.length > 0) {
      lines.push(code);
    }
  }

  lines.push(`  });`);
  lines.push(`});`);
  lines.push(``);

  const code = lines.join("\n");

  let filePath: string | undefined;
  if (outputFile) {
    const fileName = path.basename(String(outputFile));
    filePath = await writeDevBrowserTempFile(fileName, code);
  }

  return {
    code,
    filePath,
    stats: {
      actions: actionCount,
      assertions: assertionCount,
      duration,
    },
  };
}
