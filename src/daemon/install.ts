/**
 * doobie install [--force]
 * Download Chrome for Testing into ~/.doobie/chrome via @puppeteer/browsers.
 * Skips when a Chrome is already available unless --force.
 */
import { install, resolveBuildId, detectBrowserPlatform, Browser, type InstallOptions } from "@puppeteer/browsers";
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
    process.stderr.write("doobie install: unsupported platform\n");
    return EXIT_ERROR;
  }
  process.stdout.write("Resolving latest stable Chrome for Testing...\n");
  const buildId = await resolveBuildId(Browser.CHROME, platform, "stable");
  let lastPct = -1;
  const opts: InstallOptions & { unpack: true } = {
    browser: Browser.CHROME,
    buildId,
    cacheDir: paths.chromeDir(),
    unpack: true,
    downloadProgressCallback: (downloaded, total) => {
      const pct = total > 0 ? Math.floor((downloaded / total) * 100) : 0;
      if (pct !== lastPct && pct % 5 === 0) {
        lastPct = pct;
        process.stdout.write(`\rDownloading Chrome ${buildId}: ${pct}%`);
      }
    },
  };
  const installed = await install(opts);
  process.stdout.write(`\nInstalled ${installed.executablePath}\n`);
  return EXIT_OK;
}
