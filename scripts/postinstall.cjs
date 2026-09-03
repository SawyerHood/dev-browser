#!/usr/bin/env node
// npm postinstall: download the dev-browser binary for this platform from GitHub
// Releases (or DEV_BROWSER_DOWNLOAD_BASE), verify its SHA-256 against the
// release's SHA256SUMS, and for a global install (best effort) point the
// global `dev-browser` symlink straight at the binary. Never fails the install:
// bin/dev-browser.cjs downloads on first run if this step was skipped or blocked
// (bun, pnpm, --ignore-scripts, offline).
"use strict";
const fs = require("node:fs");
const dl = require("./download-binary.cjs");

if (process.env.DEV_BROWSER_SKIP_DOWNLOAD) {
  console.log("dev-browser: DEV_BROWSER_SKIP_DOWNLOAD set, not downloading the binary");
  process.exit(0);
}
// Dev checkout (source present): nothing to download; the shim runs src/ with bun.
if (fs.existsSync(dl.devEntry)) {
  process.exit(0);
}

const plat = dl.platformAsset();
if (plat.error) {
  // package.json has no "os" field on purpose: this soft message is the only gate.
  console.warn(`dev-browser: ${plat.error}; \`dev-browser\` will not work on this machine.`);
  process.exit(0);
}

dl.downloadBinary({ log: (m) => console.log(m) })
  .then(() => {
    dl.relinkGlobal({ log: (m) => console.log(m) });
  })
  .catch((err) => {
    console.warn(`dev-browser: could not download the binary (${err.message}).`);
    console.warn("dev-browser: the `dev-browser` command will retry the download on first run. To fix it now:");
    console.warn(dl.manualHint());
    process.exit(0);
  });
