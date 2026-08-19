#!/usr/bin/env node
// npm shim. postinstall downloads the native binary next to this file as
// bin/doobie-bin and, when it can, re-points the global `doobie` symlink at
// the binary so Node is not on the hot path. This shim is the fallback.
"use strict";
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const bin = path.join(__dirname, process.platform === "win32" ? "doobie-bin.exe" : "doobie-bin");
if (fs.existsSync(bin)) {
  const r = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
  process.exit(r.status === null ? 1 : r.status);
}
// Dev checkout fallback: run the TypeScript entry with bun.
const main = path.join(__dirname, "..", "src", "cli", "main.ts");
if (fs.existsSync(main)) {
  const r = spawnSync("bun", [main, ...process.argv.slice(2)], { stdio: "inherit" });
  if (r.error && r.error.code === "ENOENT") {
    console.error("doobie: binary not installed and bun not found. Run `npm rebuild doobie` or install bun.");
    process.exit(1);
  }
  process.exit(r.status === null ? 1 : r.status);
}
console.error("doobie: native binary missing. Reinstall with `npm install -g doobie` (set DOOBIE_SKIP_DOWNLOAD= to allow the download).");
process.exit(1);
