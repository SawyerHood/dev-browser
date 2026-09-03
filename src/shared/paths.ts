/**
 * Filesystem layout under the dev-browser home directory.
 *
 *   ~/.dev-browser/v1/
 *     daemon.sock        Unix socket the daemon listens on
 *     daemon.pid         pid of the daemon that owns the socket
 *     daemon.lock        spawn lock (O_EXCL) while a client starts a daemon
 *     daemon.log         rolling daemon log
 *     config.json        user defaults (headless, idleTimeout, chrome)
 *     tmp/               jail for saveFile/readFile/shot/spill files
 *     browsers/<name>/profile            persistent Chrome user-data-dir (headed)
 *     browsers/<name>/profile-headless   separate user-data-dir for the headless instance
 *     browsers/<name>/profile[-headless]-insecure   same, for --ignore-https-errors instances
 *     chrome-profiles/<name>             user-data-dirs for `dev-browser chrome --profile NAME`
 *     tmp/downloads/     download directory for launched browsers
 *     pages/<key>.json   name -> targetId map per browser key
 *     chrome/            Chrome for Testing installed by `dev-browser install`
 *     chrome-ports.json  ports remembered by `dev-browser chrome`
 *
 * DEV_BROWSER_HOME overrides the root (tests use a temp dir).
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

export function devBrowserHome(): string {
  const env = process.env.DEV_BROWSER_HOME;
  if (env && env.length > 0) return resolvePath(env);
  // v0.2 used ~/.dev-browser with an incompatible Rust/Node daemon protocol
  // and profile layout. Keep v1 isolated so an upgrade can never connect to
  // the old daemon or reinterpret its state.
  return joinPath(homedir(), ".dev-browser", "v1");
}

export const paths = {
  home: () => devBrowserHome(),
  socket: () => process.env.DEV_BROWSER_SOCKET || joinPath(devBrowserHome(), "daemon.sock"),
  pid: () => joinPath(devBrowserHome(), "daemon.pid"),
  lock: () => joinPath(devBrowserHome(), "daemon.lock"),
  log: () => joinPath(devBrowserHome(), "daemon.log"),
  config: () => joinPath(devBrowserHome(), "config.json"),
  tmp: () => joinPath(devBrowserHome(), "tmp"),
  browsers: () => joinPath(devBrowserHome(), "browsers"),
  /**
   * Chrome user-data-dir for a launched profile. Headed and headless instances
   * of one name never share a dir: Chrome's ProcessSingleton would refuse the
   * second launch (and the old orphan recovery killed the first one).
   */
  profile: (name: string, headless = false, insecure = false) =>
    joinPath(devBrowserHome(), "browsers", sanitizeName(name), "profile" + (headless ? "-headless" : "") + (insecure ? "-insecure" : "")),
  /** user-data-dir for `dev-browser chrome --profile NAME`; its own root so it never collides with -b NAME. */
  chromeProfile: (name: string) => joinPath(devBrowserHome(), "chrome-profiles", sanitizeName(name)),
  downloads: () => joinPath(devBrowserHome(), "tmp", "downloads"),
  pagesDir: () => joinPath(devBrowserHome(), "pages"),
  pagesFile: (browserKey: string) => joinPath(devBrowserHome(), "pages", sanitizeKey(browserKey) + ".json"),
  chromeDir: () => joinPath(devBrowserHome(), "chrome"),
  chromePorts: () => joinPath(devBrowserHome(), "chrome-ports.json"),
};

/** Ensure the home dir and its standard subdirs exist. Safe to call often. */
export function ensureHome(): void {
  const fs = lazyFs();
  for (const dir of [devBrowserHome(), paths.tmp(), paths.browsers(), paths.pagesDir()]) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EROFS" || code === "EPERM" || code === "ENOTDIR") {
        throw new Error(
          `cannot write to DEV_BROWSER_HOME ${devBrowserHome()} (${code}). Fix its permissions or point DEV_BROWSER_HOME at a writable directory.`,
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
