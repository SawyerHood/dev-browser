#!/usr/bin/env node
// Download the doobie binary for this platform from GitHub Releases, verify
// its SHA-256 against the release's SHA256SUMS, and (best effort) point the
// global `doobie` symlink straight at the binary.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const https = require("node:https");
const crypto = require("node:crypto");
const { execSync } = require("node:child_process");

const pkg = require("../package.json");
const REPO = process.env.DOOBIE_REPO || "SawyerHood/doobie";
const VERSION = process.env.DOOBIE_VERSION || pkg.version;

if (process.env.DOOBIE_SKIP_DOWNLOAD) {
  console.log("doobie: DOOBIE_SKIP_DOWNLOAD set, not downloading the binary");
  process.exit(0);
}
// Dev checkout (source present): nothing to download.
if (fs.existsSync(path.join(__dirname, "..", "src", "cli", "main.ts"))) {
  process.exit(0);
}

const platformMap = { darwin: "darwin", linux: "linux", win32: "windows" };
const archMap = { x64: "x64", arm64: "arm64" };
const plat = platformMap[os.platform()];
const arch = archMap[os.arch()];
if (!plat || !arch) {
  console.warn(`doobie: no prebuilt binary for ${os.platform()}/${os.arch()}; the JS shim will try bun.`);
  process.exit(0);
}
if (plat === "windows") {
  // package.json has no "os" field on purpose: this soft message is the only Windows gate.
  console.warn("doobie: Windows is not supported yet (planned after 1.0).");
  process.exit(0);
}

const asset = `doobie-${plat}-${arch}`;
const base = `https://github.com/${REPO}/releases/download/v${VERSION}`;
const dest = path.join(__dirname, "..", "bin", "doobie-bin");

function fetch(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "user-agent": "doobie-postinstall" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          res.resume();
          return resolve(fetch(res.headers.location, redirects + 1));
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

async function main() {
  console.log(`doobie: downloading ${asset} v${VERSION}...`);
  const [bin, sums] = await Promise.all([fetch(`${base}/${asset}`), fetch(`${base}/SHA256SUMS`)]);
  const line = sums
    .toString("utf8")
    .split("\n")
    .find((l) => l.trim().endsWith(` ${asset}`) || l.trim().endsWith(`*${asset}`));
  if (!line) throw new Error(`SHA256SUMS has no entry for ${asset}`);
  const expected = line.trim().split(/\s+/)[0];
  const actual = crypto.createHash("sha256").update(bin).digest("hex");
  if (expected !== actual) throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
  fs.writeFileSync(dest, bin, { mode: 0o755 });
  console.log(`doobie: installed binary at ${dest}`);
  relinkGlobal();
}

function relinkGlobal() {
  try {
    const prefix = (process.env.npm_config_prefix || execSync("npm prefix -g", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim());
    const link = path.join(prefix, "bin", "doobie");
    if (!fs.existsSync(link)) return;
    const st = fs.lstatSync(link);
    if (!st.isSymbolicLink()) return;
    const target = fs.realpathSync(link);
    if (path.basename(target) !== "doobie.cjs") return; // not ours
    fs.unlinkSync(link);
    fs.symlinkSync(dest, link);
    console.log(`doobie: ${link} now points directly at the binary`);
  } catch {
    /* best effort; the shim still works */
  }
}

main().catch((err) => {
  console.warn(`doobie: could not download the binary (${err.message}).`);
  console.warn("doobie: the JS shim will fall back to bun if available; or download manually from " + base);
  process.exit(0);
});
