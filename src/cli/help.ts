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
  const text = helpText();
  const re = new RegExp(`^## ${topic.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b[\\s\\S]*?(?=^## |\\Z)`, "im");
  const m = re.exec(text + "\n\\Z");
  if (!m) return `No help topic "${topic}". Topics: ${topics().join(", ")}\n`;
  return m[0].replace(/\n\\Z$/, "") + "\n";
}
