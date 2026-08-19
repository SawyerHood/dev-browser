/**
 * Filesystem layout under the doobie home directory.
 *
 *   ~/.doobie/
 *     daemon.sock        Unix socket the daemon listens on
 *     daemon.pid         pid of the daemon that owns the socket
 *     daemon.lock        spawn lock (O_EXCL) while a client starts a daemon
 *     daemon.log         rolling daemon log
 *     config.json        user defaults (headless, idleTimeout, chrome)
 *     tmp/               jail for saveFile/readFile/shot/spill files
 *     browsers/<name>/profile   persistent Chrome user-data-dir per profile
 *     pages/<key>.json   name -> targetId map per browser key
 *     chrome/            Chrome for Testing installed by `doobie install`
 *     chrome-ports.json  ports remembered by `doobie chrome`
 *
 * DOOBIE_HOME overrides the root (tests use a temp dir).
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export function doobieHome(): string {
  const env = process.env.DOOBIE_HOME;
  if (env && env.length > 0) return path.resolve(env);
  return path.join(os.homedir(), ".doobie");
}

export const paths = {
  home: () => doobieHome(),
  socket: () => process.env.DOOBIE_SOCKET || path.join(doobieHome(), "daemon.sock"),
  pid: () => path.join(doobieHome(), "daemon.pid"),
  lock: () => path.join(doobieHome(), "daemon.lock"),
  log: () => path.join(doobieHome(), "daemon.log"),
  config: () => path.join(doobieHome(), "config.json"),
  tmp: () => path.join(doobieHome(), "tmp"),
  browsers: () => path.join(doobieHome(), "browsers"),
  profile: (name: string) => path.join(doobieHome(), "browsers", sanitizeName(name), "profile"),
  pagesDir: () => path.join(doobieHome(), "pages"),
  pagesFile: (browserKey: string) => path.join(doobieHome(), "pages", sanitizeKey(browserKey) + ".json"),
  chromeDir: () => path.join(doobieHome(), "chrome"),
  chromePorts: () => path.join(doobieHome(), "chrome-ports.json"),
};

/** Ensure the home dir and its standard subdirs exist. Safe to call often. */
export function ensureHome(): void {
  for (const dir of [doobieHome(), paths.tmp(), paths.browsers(), paths.pagesDir()]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** Profile names become path segments. Keep them boring. */
export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  if (cleaned.length === 0) return "default";
  return cleaned.slice(0, 64);
}

/** Browser registry keys can contain URLs; hash anything that is not a plain name. */
export function sanitizeKey(key: string): string {
  if (/^[A-Za-z0-9._:-]{1,80}$/.test(key)) return key.replace(/:/g, "__");
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return "k" + h.toString(16);
}

/**
 * Resolve a file name inside the tmp jail. Rejects absolute paths, `..`,
 * null bytes, and path separators. Returns the absolute path.
 */
export function jailPath(name: string): string {
  if (typeof name !== "string" || name.length === 0) throw new Error("file name is required");
  if (name.includes("\0")) throw new Error("file name contains a null byte");
  if (path.isAbsolute(name)) throw new Error(`file name must be relative to the tmp dir, got ${name}`);
  if (name.includes("/") || name.includes("\\")) throw new Error(`file name must not contain path separators, got ${name}`);
  if (name === "." || name === ".." ) throw new Error(`invalid file name ${name}`);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`file name may only contain [A-Za-z0-9._-], got ${name}`);
  return path.join(paths.tmp(), name);
}
