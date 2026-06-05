import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { build } from "esbuild";

const daemonDir = resolve(import.meta.dirname, "..");
const entryPoint = resolve(daemonDir, "src/sandbox/forked-client/bundle-entry.ts");
const outfile = resolve(daemonDir, "dist/sandbox-client.js");

await mkdir(dirname(outfile), { recursive: true });

// WARNING: src/sandbox/forked-client/src/client/domCuaInjected.ts exports
// functions that are serialized with String(fn) and re-evaluated inside the
// page. Do not add flags that rewrite function bodies (minify, keepNames) —
// they would corrupt the serialized source.
await build({
  entryPoints: [entryPoint],
  bundle: true,
  format: "iife",
  globalName: "__PlaywrightClient",
  outfile,
  platform: "neutral",
  target: "es2022",
});
