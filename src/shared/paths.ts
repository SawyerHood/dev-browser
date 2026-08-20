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
 *     browsers/<name>/profile            persistent Chrome user-data-dir (headed)
 *     browsers/<name>/profile-headless   separate user-data-dir for the headless instance
 *     browsers/<name>/profile[-headless]-insecure   same, for --ignore-https-errors instances
 *     chrome-profiles/<name>             user-data-dirs for `doobie chrome --profile NAME`
 *     tmp/downloads/     download directory for launched browsers
 *     pages/<key>.json   name -> targetId map per browser key
 *     chrome/            Chrome for Testing installed by `doobie install`
 *     chrome-ports.json  ports remembered by `doobie chrome`
 *
 * DOOBIE_HOME overrides the root (tests use a temp dir).
 */

// No top-level node:* imports here: this module is on the client's hot path
// and `node:fs`/`node:path`/`node:os` cost several ms of startup under Bun.
// Posix-only helpers (Windows lands after 1.0).

type FsModule = typeof import("node:fs");
let fsMod: FsModule | null = null;
/** Lazily loaded node:fs (only slow paths need it). */
export function lazyFs(): FsModule {
  if (!fsMod) fsMod = require("node:fs") as FsModule;
  return fsMod;
}

export function joinPath(...parts: string[]): string {
  let out = "";
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("/")) out = part;
    else out = out.length === 0 || out.endsWith("/") ? out + part : out + "/" + part;
  }
  return normalizePath(out);
}

export function normalizePath(p: string): string {
  const abs = p.startsWith("/");
  const segs: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segs.length > 0 && segs[segs.length - 1] !== "..") segs.pop();
      else if (!abs) segs.push("..");
      continue;
    }
    segs.push(seg);
  }
  const joined = segs.join("/");
  return abs ? "/" + joined : joined || ".";
}

export function resolvePath(p: string): string {
  if (p.startsWith("/")) return normalizePath(p);
  return normalizePath(process.cwd() + "/" + p);
}

export function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

export function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  return p.slice(0, i);
}

export function homedir(): string {
  const h = process.env.HOME || process.env.USERPROFILE;
  if (h && h.length > 0) return h;
  return (require("node:os") as typeof import("node:os")).homedir();
}

export function doobieHome(): string {
  const env = process.env.DOOBIE_HOME;
  if (env && env.length > 0) return resolvePath(env);
  return joinPath(homedir(), ".doobie");
}

export const paths = {
  home: () => doobieHome(),
  socket: () => process.env.DOOBIE_SOCKET || joinPath(doobieHome(), "daemon.sock"),
  pid: () => joinPath(doobieHome(), "daemon.pid"),
  lock: () => joinPath(doobieHome(), "daemon.lock"),
  log: () => joinPath(doobieHome(), "daemon.log"),
  config: () => joinPath(doobieHome(), "config.json"),
  tmp: () => joinPath(doobieHome(), "tmp"),
  browsers: () => joinPath(doobieHome(), "browsers"),
  /**
   * Chrome user-data-dir for a launched profile. Headed and headless instances
   * of one name never share a dir: Chrome's ProcessSingleton would refuse the
   * second launch (and the old orphan recovery killed the first one).
   */
  profile: (name: string, headless = false, insecure = false) =>
    joinPath(doobieHome(), "browsers", sanitizeName(name), "profile" + (headless ? "-headless" : "") + (insecure ? "-insecure" : "")),
  /** user-data-dir for `doobie chrome --profile NAME`; its own root so it never collides with -b NAME. */
  chromeProfile: (name: string) => joinPath(doobieHome(), "chrome-profiles", sanitizeName(name)),
  downloads: () => joinPath(doobieHome(), "tmp", "downloads"),
  pagesDir: () => joinPath(doobieHome(), "pages"),
  pagesFile: (browserKey: string) => joinPath(doobieHome(), "pages", sanitizeKey(browserKey) + ".json"),
  chromeDir: () => joinPath(doobieHome(), "chrome"),
  chromePorts: () => joinPath(doobieHome(), "chrome-ports.json"),
};

/** Ensure the home dir and its standard subdirs exist. Safe to call often. */
export function ensureHome(): void {
  const fs = lazyFs();
  for (const dir of [doobieHome(), paths.tmp(), paths.browsers(), paths.pagesDir()]) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EROFS" || code === "EPERM" || code === "ENOTDIR") {
        throw new Error(
          `cannot write to DOOBIE_HOME ${doobieHome()} (${code}). Fix its permissions or point DOOBIE_HOME at a writable directory.`,
        );
      }
      throw err;
    }
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
  if (isAbsolutePath(name)) throw new Error(`file name must be relative to the tmp dir, got ${name}`);
  // One sanctioned subdirectory: browser downloads land in tmp/downloads/<name>.
  if (name.startsWith("downloads/")) {
    const rest = name.slice("downloads/".length);
    if (rest.includes("/") || rest.includes("\\")) throw new Error(`file name must not contain path separators, got ${name}`);
    if (!/^[A-Za-z0-9._ ()-]+$/.test(rest) || rest === "." || rest === "..") throw new Error(`invalid download file name ${name}`);
    return joinPath(paths.tmp(), "downloads", rest);
  }
  if (name.includes("/") || name.includes("\\")) throw new Error(`file name must not contain path separators, got ${name}`);
  if (name === "." || name === ".." ) throw new Error(`invalid file name ${name}`);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`file name may only contain [A-Za-z0-9._-], got ${name}`);
  return joinPath(paths.tmp(), name);
}
