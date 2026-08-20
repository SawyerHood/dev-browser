#!/usr/bin/env node
// npm shim. postinstall downloads the native binary next to this file as
// bin/doobie-bin and, for global installs, re-points the global `doobie`
// symlink at the binary so Node is not on the hot path. This shim is the
// fallback: it runs the binary, downloads it first if the install step was
// skipped (bun / pnpm / --ignore-scripts / offline at install time), or runs
// the TypeScript entry with bun in a git checkout.
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const dl = require("../scripts/download-binary.cjs");

const args = process.argv.slice(2);

function runBinary() {
  const bin = dl.binPath;
  const r = spawnSync(bin, args, { stdio: "inherit" });
  if (r.status === null) {
    // Could not run (musl vs glibc, CPU without AVX2, noexec mount, truncated download) or died by signal.
    const why = r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : "unknown error";
    console.error(`doobie: could not run the prebuilt binary ${bin}: ${why}`);
    console.error(
      "doobie: hints: check `file " + bin + "` matches this OS/CPU (glibc x64/arm64 and macOS builds only; no musl/baseline yet);\n" +
        "  if the download was truncated, delete it and rerun `doobie` (it re-downloads) or `npm rebuild -g doobie`;\n" +
        "  on a noexec mount or unsupported CPU: git clone https://github.com/" + dl.REPO + " && bun run build" +
        (fs.existsSync(dl.devEntry) ? "\n  (dev checkout: remove " + bin + " and the shim runs " + dl.devEntry + " with bun)." : "."),
    );
    process.exit(1);
  }
  process.exit(r.status);
}

function runDev() {
  const main = dl.devEntry;
  const r = spawnSync("bun", [main, ...args], { stdio: "inherit" });
  if (r.error && r.error.code === "ENOENT") {
    console.error(`doobie: no binary at ${dl.binPath} and bun not found to run ${main}. Install bun or run \`bun run build\`.`);
    process.exit(1);
  }
  if (r.status === null) {
    console.error(`doobie: bun failed to run ${main}: ${r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : "unknown error"}`);
    process.exit(1);
  }
  process.exit(r.status);
}

if (fs.existsSync(dl.binPath)) runBinary();
else if (fs.existsSync(dl.devEntry)) runDev();
else if (process.env.DOOBIE_SKIP_DOWNLOAD) {
  console.error(`doobie: native binary missing at ${dl.binPath} and DOOBIE_SKIP_DOWNLOAD is set, so it will not be downloaded.`);
  console.error(dl.manualHint());
  process.exit(1);
} else {
  // Self-heal: the install script did not run (or failed). Fetch the binary now, then run it.
  const plat = dl.platformAsset();
  if (plat.error) {
    console.error(`doobie: ${plat.error}.`);
    process.exit(1);
  }
  console.error(`doobie: downloading binary v${dl.VERSION}...`);
  dl.downloadBinary()
    .then(() => runBinary())
    .catch((err) => {
      console.error(`doobie: could not download the binary (${err.message}).`);
      console.error("doobie: the binary is fetched on first run; if you are offline, retry when connected, or:");
      console.error(dl.manualHint());
      process.exit(1);
    });
}
