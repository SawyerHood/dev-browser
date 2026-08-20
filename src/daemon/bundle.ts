/**
 * Public surface of the daemon bundle (build/daemon.js). Everything that
 * needs node:* modules or Puppeteer lives here so the client bundle stays
 * free of them (they cost ~10 ms of startup under Bun).
 */
export { startDaemon } from "./main.ts";
export { installChrome } from "./install.ts";
export { installSkill } from "../cli/commands/install-skill.ts";
export { chromeCommand } from "../cli/commands/chrome.ts";
export { mcpMain } from "../mcp/server.ts";
