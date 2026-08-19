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
import { findChrome, listChromeCandidates } from "../../shared/chrome.ts";
import { paths, ensureHome, sanitizeName } from "../../shared/paths.ts";
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
  const exe = chromePath ?? findChrome()?.path;
  if (!exe) {
    process.stderr.write("doobie chrome: no Chrome found. Pass --chrome /path/to/chrome or run `doobie install`.\n");
    return EXIT_ERROR;
  }
  ensureHome();
  const userDataDir = paths.profile(sanitizeName(profile));
  fs.mkdirSync(userDataDir, { recursive: true });
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
      `use:  doobie --connect ${chosenPort} -e 'await (await browser.getPage("main")).title()'\n` +
      `or:   doobie --connect   (auto-discovers this port)\n`,
  );
  return EXIT_OK;
}

function usage(msg: string): number {
  process.stderr.write(`doobie chrome: ${msg}\n`);
  return EXIT_USAGE;
}
