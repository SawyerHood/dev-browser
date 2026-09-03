/**
 * dev-browser install-skill [--claude] [--codex] [--agents]
 * Writes skills/dev-browser/SKILL.md into the agent skill directories.
 * With no flags: all three (non-interactive friendly).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// @ts-ignore - text import
import SKILL from "../../../skills/dev-browser/SKILL.md" with { type: "text" };
import { EXIT_OK, EXIT_USAGE } from "../../shared/protocol.ts";
import { VERSION } from "../../shared/version.ts";

const TARGETS: Record<string, string> = {
  claude: path.join(os.homedir(), ".claude", "skills", "dev-browser"),
  codex: path.join(os.homedir(), ".codex", "skills", "dev-browser"),
  agents: path.join(os.homedir(), ".agents", "skills", "dev-browser"),
};

export async function installSkill(args: string[]): Promise<number> {
  const chosen: string[] = [];
  for (const a of args) {
    const key = a.replace(/^--/, "");
    if (!(key in TARGETS)) {
      process.stderr.write(`dev-browser install-skill: unknown target ${a}. Use --claude, --codex, --agents.\n`);
      return EXIT_USAGE;
    }
    chosen.push(key);
  }
  const targets = chosen.length > 0 ? chosen : Object.keys(TARGETS);
  const content = (SKILL as string).replace(/\{\{VERSION\}\}/g, VERSION);
  for (const t of targets) {
    const dir = TARGETS[t]!;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    fs.writeFileSync(file, content);
    process.stdout.write(`wrote ${file}\n`);
  }
  return EXIT_OK;
}
