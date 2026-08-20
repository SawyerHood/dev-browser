/**
 * Build: (1) bundle the daemon to build/daemon.js, (2) compile the CLI into
 * a single binary that embeds that bundle.
 *
 *   bun run scripts/build.ts daemon     -> build/daemon.js
 *   bun run scripts/build.ts all        -> build/daemon.js + dist/doobie
 *   bun run scripts/build.ts all --target bun-darwin-arm64 (cross-compile)
 */
import { $ } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const what = process.argv[2] ?? "all";
const targetIdx = process.argv.indexOf("--target");
const target = targetIdx > 0 ? process.argv[targetIdx + 1] : undefined;
const outfileIdx = process.argv.indexOf("--outfile");
const outfile = outfileIdx > 0 ? process.argv[outfileIdx + 1]! : path.join(root, "dist", "doobie");

delete process.env.NODE_PATH;
fs.mkdirSync(path.join(root, "build"), { recursive: true });
fs.mkdirSync(path.join(root, "dist"), { recursive: true });

async function buildDaemon(): Promise<void> {
  const t0 = Date.now();
  const result = await Bun.build({
    entrypoints: [path.join(root, "src/daemon/bundle.ts")],
    outdir: path.join(root, "build"),
    naming: "daemon.js",
    target: "bun",
    format: "esm",
    // Keep identifiers: puppeteer-core's errors set `this.name =
    // this.constructor.name`, so identifier minification turns TimeoutError
    // into "B8" in every error line and in e.name inside scripts.
    minify: { whitespace: true, syntax: true, identifiers: false },
    sourcemap: "none",
    // yauzl is bundled so `doobie install` works without an `unzip` binary;
    // proxy-agent (optional HTTPS_PROXY support) stays out of the bundle.
    external: ["proxy-agent"],
  });
  if (!result.success) {
    for (const l of result.logs) console.error(l);
    throw new Error("daemon bundle failed");
  }
  const size = fs.statSync(path.join(root, "build/daemon.js")).size;
  console.log(`build/daemon.js ${(size / 1024).toFixed(0)} KB in ${Date.now() - t0}ms`);
}

async function compileCli(): Promise<void> {
  const t0 = Date.now();
  const args = [
    "build",
    "--compile",
    "--minify-whitespace",
    "--minify-syntax",
    path.join(root, "src/cli/compiled-entry.ts"),
    "--outfile",
    outfile,
  ];
  if (target) args.push("--target", target);
  await $`bun ${args}`.cwd(root);
  const size = fs.statSync(outfile).size;
  console.log(`${path.relative(root, outfile)} ${(size / 1024 / 1024).toFixed(0)} MB in ${Date.now() - t0}ms`);
}

if (what === "daemon") await buildDaemon();
else {
  await buildDaemon();
  await compileCli();
}
