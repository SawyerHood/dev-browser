/**
 * doobie chrome [--profile NAME] [--port N] [--chrome PATH] [URL]
 *
 * Launch the user's installed Chrome as a normal OS process with remote
 * debugging on a dedicated profile, and remember the port so `doobie --connect`
 * (auto) finds it. This is the path where Google sign-in works.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import { spawn } from "node:child_process";
import { listChromeCandidates, type ChromeCandidate } from "../../shared/chrome.ts";
import { paths, ensureHome } from "../../shared/paths.ts";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "../../shared/protocol.ts";

function freePort(start: number): Promise<number> {
  return new Promise((resolve) => {
    const tryPort = (p: number) => {
      const srv = net.createServer();
      srv.once("error", () => tryPort(p + 1));
      srv.listen(p, "127.0.0.1", () => {
        srv.close(() => resolve(p));
      });
    };
    tryPort(start);
  });
}

/**
 * `doobie chrome` exists so Google/OAuth sign-in works, which rejects
 * automation builds. So prefer the user's real browser: system Chrome first,
 * then explicit overrides, and Chrome for Testing / Playwright only as a last
 * resort (with a warning). This is the reverse of findChrome()'s order.
 */
export function pickChromeForUser(candidates: ChromeCandidate[]): ChromeCandidate | null {
  const rank: Record<ChromeCandidate["source"], number> = { system: 0, env: 1, config: 2, installed: 3, playwright: 4 };
  let best: ChromeCandidate | null = null;
  for (const c of candidates) if (!best || rank[c.source] < rank[best.source]) best = c;
  return best;
}

export async function chromeCommand(args: string[]): Promise<number> {
  let profile = "chrome";
  let port: number | undefined;
  let chromePath: string | undefined;
  let url: string | undefined;
  let list = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = args[i + 1];
    if (a === "--profile" || a === "-p") {
      if (!next) return usage("--profile requires a name");
      profile = next;
      i++;
    } else if (a === "--port") {
      if (!next) return usage("--port requires a number");
      port = Number(next);
      i++;
    } else if (a === "--chrome") {
      if (!next) return usage("--chrome requires a path");
      chromePath = next;
      i++;
    } else if (a === "--list") {
      list = true;
    } else if (a.startsWith("-")) {
      return usage(`unknown flag ${a}`);
    } else {
      url = a;
    }
  }
  if (list) {
    for (const c of listChromeCandidates()) process.stdout.write(`${c.source.padEnd(10)} ${c.path}\n`);
    return EXIT_OK;
  }
  const picked = chromePath ? { path: chromePath, source: "env" as const } : pickChromeForUser(listChromeCandidates());
  const exe = picked?.path;
  if (!exe || !picked) {
    process.stderr.write("doobie chrome: no Chrome found. Pass --chrome /path/to/chrome or run `doobie install`.\n");
    return EXIT_ERROR;
  }
  if (!chromePath && (picked.source === "installed" || picked.source === "playwright")) {
    process.stderr.write(
      `doobie chrome: no system Chrome found; using ${picked.source === "installed" ? "Chrome for Testing" : "Playwright's Chromium"} (${exe}).\n` +
        "  Google sign-in may reject it. Install Google Chrome or pass --chrome /path/to/chrome.\n",
    );
  }
  ensureHome();
  // Own root (chrome-profiles/NAME), never browsers/NAME/profile: a profile dir
  // can hold one Chrome at a time, and `-b NAME` must stay launchable.
  const userDataDir = paths.chromeProfile(profile);
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const chosenPort = port ?? (await freePort(9222));
  const chromeArgs = [
    `--remote-debugging-port=${chosenPort}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
  ];
  if (url) chromeArgs.push(url);
  const child = spawn(exe, chromeArgs, { detached: true, stdio: "ignore" });
  child.unref();
  // remember the port
  let ports: Record<string, { port: number; pid: number; profile: string; at: number }> = {};
  try {
    ports = JSON.parse(fs.readFileSync(paths.chromePorts(), "utf8"));
  } catch {
    /* none yet */
  }
  ports[profile] = { port: chosenPort, pid: child.pid ?? 0, profile: userDataDir, at: Date.now() };
  fs.writeFileSync(paths.chromePorts(), JSON.stringify(ports, null, 2), { mode: 0o600 });
  process.stdout.write(
    `launched Chrome (pid ${child.pid}) on port ${chosenPort} with profile ${userDataDir}\n` +
      `chrome: ${exe}${chromePath ? "" : ` (${picked.source})`}\n` +
      `use:  doobie --connect ${chosenPort} -e 'await (await browser.getPage("main")).title()'\n` +
      `or:   doobie --connect   (auto-discovers this port)\n`,
  );
  return EXIT_OK;
}

function usage(msg: string): number {
  process.stderr.write(`doobie chrome: ${msg}\n`);
  return EXIT_USAGE;
}
