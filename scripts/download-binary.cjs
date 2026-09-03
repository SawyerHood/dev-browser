// Shared by scripts/postinstall.cjs and bin/dev-browser.cjs: locate, download and
// verify the prebuilt dev-browser binary for this platform, and (for global npm
// installs) point the global `dev-browser` symlink straight at it.
//
// Env knobs:
//   DEV_BROWSER_SKIP_DOWNLOAD=1       never download (postinstall and shim both honour it)
//   DEV_BROWSER_DOWNLOAD_BASE=URL     full URL prefix holding dev-browser-<os>-<arch> + SHA256SUMS
//                                (default https://github.com/<REPO>/releases/download/v<VERSION>)
//   DEV_BROWSER_REPO=owner/name       GitHub repo used to build the default base
//   DEV_BROWSER_VERSION=x.y.z         release version used to build the default base
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const { execSync } = require("node:child_process");

const pkgRoot = path.join(__dirname, "..");
const pkg = require(path.join(pkgRoot, "package.json"));
const REPO = process.env.DEV_BROWSER_REPO || "SawyerHood/dev-browser";
const VERSION = process.env.DEV_BROWSER_VERSION || pkg.version;

/** Where the binary lives inside the package. */
const binPath = path.join(pkgRoot, "bin", process.platform === "win32" ? "dev-browser-bin.exe" : "dev-browser-bin");
/** The JS shim (what npm links `dev-browser` to before relinkGlobal runs). */
const shimPath = path.join(pkgRoot, "bin", "dev-browser.cjs");
/** Present only in a git checkout; the published tarball has no src/. */
const devEntry = path.join(pkgRoot, "src", "cli", "main.ts");

function defaultBase() {
  return `https://github.com/${REPO}/releases/download/v${VERSION}`;
}

function downloadBase() {
  const b = process.env.DEV_BROWSER_DOWNLOAD_BASE;
  return (b && b.replace(/\/+$/, "")) || defaultBase();
}

/**
 * Asset name for this machine, or { error } when there is no prebuilt binary.
 * Windows gets a soft message (package.json has no "os" field on purpose).
 */
function platformAsset() {
  const platformMap = { darwin: "darwin", linux: "linux", win32: "windows" };
  const archMap = { x64: "x64", arm64: "arm64" };
  const plat = platformMap[os.platform()];
  const arch = archMap[os.arch()];
  if (!plat || !arch) return { error: `no prebuilt binary for ${os.platform()}/${os.arch()}` };
  if (plat === "windows") return { error: "Windows is not supported yet (planned after 1.0)" };
  return { asset: `dev-browser-${plat}-${arch}`, plat, arch };
}

function fetch(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("http://") ? http : https;
    mod
      .get(url, { headers: { "user-agent": "dev-browser-postinstall" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          res.resume();
          return resolve(fetch(new URL(res.headers.location, url).toString(), redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

/** Find the hex digest for `asset` in a sha256sum-style listing, or null. */
function findChecksum(sumsText, asset) {
  const line = sumsText
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.endsWith(` ${asset}`) || l.endsWith(`*${asset}`));
  return line ? line.split(/\s+/)[0].toLowerCase() : null;
}

/**
 * Download `<base>/<asset>` and `<base>/SHA256SUMS`, verify, and write the
 * binary atomically to `dest` (mode 0755). Resolves { dest, asset, base }.
 * Throws on any failure (nothing is left at dest).
 */
async function downloadBinary(opts = {}) {
  const log = opts.log || (() => {});
  const base = opts.base || downloadBase();
  const dest = opts.dest || binPath;
  const p = platformAsset();
  if (p.error) throw new Error(p.error);
  const { asset } = p;
  log(`dev-browser: downloading ${asset} v${VERSION} from ${base}`);
  const [bin, sums] = await Promise.all([fetch(`${base}/${asset}`), fetch(`${base}/SHA256SUMS`)]);
  const expected = findChecksum(sums.toString("utf8"), asset);
  if (!expected) throw new Error(`SHA256SUMS has no entry for ${asset}`);
  const actual = crypto.createHash("sha256").update(bin).digest("hex");
  if (expected !== actual) throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Write to a temp name and rename so a concurrent shim never execs a partial file.
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, bin, { mode: 0o755 });
    fs.renameSync(tmp, dest);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  log(`dev-browser: installed binary at ${dest}`);
  return { dest, asset, base };
}

/**
 * For a *global* npm install only: if `<prefix>/bin/dev-browser` is a symlink that
 * resolves to THIS package's bin/dev-browser.cjs, re-point it at the binary so Node
 * is not on the hot path. Returns true when the link was rewritten.
 * Never touches anything during a project-local install (npm sets
 * npm_config_prefix to the global prefix even then).
 */
function relinkGlobal(opts = {}) {
  const env = opts.env || process.env;
  const dest = opts.dest || binPath;
  const shim = opts.shim || shimPath;
  try {
    if (env.npm_config_global !== "true") return false;
    const prefix =
      opts.prefix ||
      env.npm_config_prefix ||
      execSync("npm prefix -g", { stdio: ["ignore", "pipe", "ignore"], env }).toString().trim();
    const link = path.join(prefix, "bin", "dev-browser");
    if (!fs.existsSync(link)) return false;
    if (!fs.lstatSync(link).isSymbolicLink()) return false;
    if (fs.realpathSync(link) !== fs.realpathSync(shim)) return false; // not ours
    fs.unlinkSync(link);
    fs.symlinkSync(dest, link);
    if (opts.log) opts.log(`dev-browser: ${link} now points directly at the binary`);
    return true;
  } catch {
    return false; // best effort; the shim still works
  }
}

/** Human hint for "the binary is not here and cannot be fetched". */
function manualHint() {
  const p = platformAsset();
  const asset = p.asset || "dev-browser-<os>-<arch>";
  const lines = [
    `  - run \`npm rebuild -g dev-browser\` (re-runs the download; make sure DEV_BROWSER_SKIP_DOWNLOAD is unset),`,
    `  - or download ${asset} from ${downloadBase()} to ${binPath} and chmod +x it,`,
    `  - or build from source: git clone https://github.com/${REPO} && bun run build.`,
  ];
  if (fs.existsSync(devEntry)) lines.push(`  - (dev checkout detected: the shim runs ${devEntry} with bun when no binary is present.)`);
  return lines.join("\n");
}

module.exports = {
  REPO,
  VERSION,
  binPath,
  shimPath,
  devEntry,
  defaultBase,
  downloadBase,
  platformAsset,
  findChecksum,
  fetch,
  downloadBinary,
  relinkGlobal,
  manualHint,
};
