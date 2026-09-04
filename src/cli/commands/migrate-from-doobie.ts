/**
 * Copy durable state from the predecessor's ~/.doobie directory into the
 * versioned dev-browser v1 home. The source is never modified.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { EXIT_ERROR, EXIT_OK } from "../../shared/protocol.ts";
import { homedir, paths, resolvePath } from "../../shared/paths.ts";

const DURABLE_ENTRIES = ["config.json", "browsers", "chrome-profiles", "pages", "chrome", "tmp", "launch-state.json"];

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function activeLegacyPids(source: string): number[] {
  const pids = new Set<number>();
  const add = (value: unknown): void => {
    const pid = Number(value);
    if (processIsAlive(pid)) pids.add(pid);
  };
  try {
    const ports = JSON.parse(fs.readFileSync(path.join(source, "chrome-ports.json"), "utf8")) as Record<string, { pid?: number }>;
    for (const entry of Object.values(ports)) add(entry.pid);
  } catch {
    // Missing or invalid metadata is ignored; profile locks are checked below.
  }
  for (const root of [path.join(source, "browsers"), path.join(source, "chrome-profiles")]) {
    if (!fs.existsSync(root)) continue;
    for (const relativeLock of fs.globSync("**/SingletonLock", { cwd: root })) {
      try {
        const lock = path.join(root, relativeLock);
        const target = fs.readlinkSync(lock);
        add(target.slice(target.lastIndexOf("-") + 1));
      } catch {
        // A missing/non-symlink lock is not evidence of a running Chrome.
      }
    }
  }
  return [...pids].sort((a, b) => a - b);
}

export function legacyDoobieHome(): string {
  const configured = process.env.DOOBIE_HOME;
  return configured ? resolvePath(configured) : path.join(homedir(), ".doobie");
}

export function migrateFromDoobie(): number {
  const source = legacyDoobieHome();
  const target = paths.home();

  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    process.stderr.write(`dev-browser: no doobie state directory found at ${source}\n`);
    return EXIT_ERROR;
  }

  try {
    const pid = Number(fs.readFileSync(path.join(source, "daemon.pid"), "utf8").trim());
    if (processIsAlive(pid)) {
      process.stderr.write(`dev-browser: doobie daemon pid ${pid} is still running. Run \`doobie stop\` before migrating.\n`);
      return EXIT_ERROR;
    }
  } catch {
    // No readable pid file means there is no known live daemon.
  }

  const activePids = activeLegacyPids(source);
  if (activePids.length > 0) {
    process.stderr.write(
      `dev-browser: doobie Chrome process${activePids.length === 1 ? "" : "es"} ${activePids.join(", ")} ` +
        "still use the source profiles. Quit them before migrating.\n",
    );
    return EXIT_ERROR;
  }

  const existing = DURABLE_ENTRIES.filter((entry) => fs.existsSync(path.join(target, entry)));
  if (existing.length > 0) {
    process.stderr.write(
      `dev-browser: refusing to overwrite existing v1 state in ${target} (${existing.join(", ")}).\n` +
        "Move that directory aside or use DEV_BROWSER_HOME to select an empty destination.\n",
    );
    return EXIT_ERROR;
  }

  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const copied: string[] = [];
  for (const entry of DURABLE_ENTRIES) {
    const from = path.join(source, entry);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(target, entry), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    copied.push(entry);
  }

  if (copied.length === 0) {
    process.stderr.write(`dev-browser: ${source} contains no durable state to migrate\n`);
    return EXIT_ERROR;
  }

  process.stdout.write(`copied ${copied.join(", ")} from ${source} to ${target}\n`);
  process.stdout.write("the original doobie state was left unchanged\n");
  return EXIT_OK;
}
