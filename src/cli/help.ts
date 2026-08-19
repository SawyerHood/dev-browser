/**
 * Help text: docs/help.md is the single source of truth. It is embedded at
 * bundle time as text. `doobie help <topic>` prints one `## topic` section.
 */
// @ts-ignore - text import
import HELP from "../../docs/help.md" with { type: "text" };
import { VERSION } from "../shared/version.ts";

export function helpText(): string {
  return (HELP as string).replace(/\{\{VERSION\}\}/g, VERSION);
}

export function topics(): string[] {
  return [...(HELP as string).matchAll(/^## ([\w-]+)/gm)].map((m) => m[1]!.toLowerCase());
}

export function topicText(topic: string): string {
  const lines = helpText().split("\n");
  const want = `## ${topic.toLowerCase()}`;
  const start = lines.findIndex((l) => l.toLowerCase() === want || l.toLowerCase().startsWith(want + " "));
  if (start < 0) return `No help topic "${topic}". Topics: ${topics().join(", ")}\n`;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join("\n").replace(/\n+$/, "") + "\n";
}
