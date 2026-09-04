/**
 * dev-browser install [--force]
 * Download Chrome for Testing into ~/.dev-browser/v1/chrome via @puppeteer/browsers.
 * Skips when a Chrome is already available unless --force.
 *
 * The zip is extracted with the bundled `yauzl` when `unzip` is missing, so
 * slim containers work too. A failed install never leaves a half-written
 * version dir behind (which would wedge every retry), and --force replaces an
 * existing one.
 */
import * as fs from "node:fs";
import { install, resolveBuildId, detectBrowserPlatform, Browser, Cache, type InstallOptions } from "@puppeteer/browsers";
import { findChrome } from "../shared/chrome.ts";
import { paths, ensureHome } from "../shared/paths.ts";
import { EXIT_ERROR, EXIT_OK } from "../shared/protocol.ts";

export async function installChrome(args: string[]): Promise<number> {
  const force = args.includes("--force");
  const existing = findChrome();
  if (existing && !force && existing.source !== "playwright") {
    process.stdout.write(`Chrome already available (${existing.source}): ${existing.path}\nUse --force to download Chrome for Testing anyway.\n`);
    return EXIT_OK;
  }
  ensureHome();
  const platform = detectBrowserPlatform();
  if (!platform) {
    process.stderr.write("dev-browser install: unsupported platform\n");
    return EXIT_ERROR;
  }
  process.stdout.write("Resolving latest stable Chrome for Testing...\n");
  let buildId: string;
  try {
    buildId = await resolveBuildId(Browser.CHROME, platform, "stable");
  } catch (err) {
    process.stderr.write(`dev-browser install: could not resolve the latest Chrome for Testing build: ${(err as Error).message}\n`);
    return EXIT_ERROR;
  }
  const cacheDir = paths.chromeDir();
  const installDir = new Cache(cacheDir).installationDir(Browser.CHROME, platform, buildId);
  if (fs.existsSync(installDir)) {
    if (!force) {
      process.stderr.write(
        `dev-browser install: ${installDir} already exists but no usable Chrome was found in it.\n` +
          "Run `dev-browser install --force` to replace it.\n",
      );
      return EXIT_ERROR;
    }
    process.stdout.write(`Removing existing ${installDir}\n`);
    fs.rmSync(installDir, { recursive: true, force: true });
  }
  let lastPct = -1;
  const opts: InstallOptions & { unpack: true } = {
    browser: Browser.CHROME,
    buildId,
    cacheDir,
    unpack: true,
    downloadProgressCallback: (downloaded, total) => {
      const pct = total > 0 ? Math.floor((downloaded / total) * 100) : 0;
      if (pct !== lastPct && pct % 5 === 0) {
        lastPct = pct;
        process.stdout.write(`\rDownloading Chrome ${buildId}: ${pct}%`);
      }
    },
  };
  try {
    const installed = await install(opts);
    process.stdout.write(`\nInstalled ${installed.executablePath}\n`);
    return EXIT_OK;
  } catch (err) {
    // Leave nothing behind: a partial version dir makes every later install fail.
    fs.rmSync(installDir, { recursive: true, force: true });
    const msg = (err as Error)?.message ?? String(err);
    process.stderr.write(`\ndev-browser install: failed: ${msg.split("\n")[0]}\n`);
    process.stderr.write(`Nothing was left in ${cacheDir}; fix the cause (network/proxy, disk space) and retry.\n`);
    return EXIT_ERROR;
  }
}
