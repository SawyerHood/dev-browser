#!/usr/bin/env node
// npm postinstall: download the doobie binary for this platform from GitHub
// Releases (or DOOBIE_DOWNLOAD_BASE), verify its SHA-256 against the
// release's SHA256SUMS, and for a global install (best effort) point the
// global `doobie` symlink straight at the binary. Never fails the install:
// bin/doobie.cjs downloads on first run if this step was skipped or blocked
// (bun, pnpm, --ignore-scripts, offline).
"use strict";
const fs = require("node:fs");
const dl = require("./download-binary.cjs");

if (process.env.DOOBIE_SKIP_DOWNLOAD) {
  console.log("doobie: DOOBIE_SKIP_DOWNLOAD set, not downloading the binary");
  process.exit(0);
}
// Dev checkout (source present): nothing to download; the shim runs src/ with bun.
if (fs.existsSync(dl.devEntry)) {
  process.exit(0);
}

const plat = dl.platformAsset();
if (plat.error) {
  // package.json has no "os" field on purpose: this soft message is the only gate.
  console.warn(`doobie: ${plat.error}; \`doobie\` will not work on this machine.`);
  process.exit(0);
}

dl.downloadBinary({ log: (m) => console.log(m) })
  .then(() => {
    dl.relinkGlobal({ log: (m) => console.log(m) });
  })
  .catch((err) => {
    console.warn(`doobie: could not download the binary (${err.message}).`);
    console.warn("doobie: the `doobie` command will retry the download on first run. To fix it now:");
    console.warn(dl.manualHint());
    process.exit(0);
  });
