/**
 * doobie CLI entry. Keep this module and its static imports small: the
 * client must start in ~20 ms. Heavy code (daemon, Chrome download) lives in
 * the daemon bundle and is loaded with a dynamic import only when needed.
 */
import { parseArgs, UsageError, type GlobalFlags } from "./args.ts";
import { sendRequest } from "./client.ts";
import { OutputSink } from "./output.ts";
import {
  EXIT_ERROR,
  EXIT_OK,
  EXIT_TIMEOUT,
  EXIT_USAGE,
  type BrowserInfo,
  type BrowserSourceSpec,
  type Frame,
  type PagesPayload,
  type RunRequest,
  type StatusPayload,
} from "../shared/protocol.ts";
import { DEFAULTS, loadConfigAsync, resolveIdleTimeoutMs, formatDuration, type DoobieConfig } from "../shared/config.ts";
import { resolvePath, basename } from "../shared/paths.ts";
import { VERSION } from "../shared/version.ts";
import { loadDaemonModule } from "./daemon-loader.ts";
import { helpText, topicText } from "./help.ts";
import { out, err as writeErr, flushAll, stdinIsTTY } from "./io.ts";

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      writeErr(`doobie: ${err.message}\n`);
      return EXIT_USAGE;
    }
    throw err;
  }
  const { flags, command } = parsed;
  if (flags.version) {
    out(`doobie ${VERSION}\n`);
    return EXIT_OK;
  }
  if (flags.help) {
    out(helpText());
    return EXIT_OK;
  }

  switch (command.kind) {
    case "daemon": {
      const mod = await loadDaemonModule();
      await mod.startDaemon();
      return new Promise(() => {}); // the daemon owns the process from here
    }
    case "help": {
      out(command.topic ? topicText(command.topic) : helpText());
      return EXIT_OK;
    }
    case "install": {
      const mod = await loadDaemonModule();
      return mod.installChrome(command.args);
    }
    case "install-skill": {
      const mod = await loadDaemonModule();
      return mod.installSkill(command.args);
    }
    case "chrome": {
      const mod = await loadDaemonModule();
      return mod.chromeCommand(command.args);
    }
    case "status":
      return simpleRequest({ type: "status" }, flags, renderStatus);
    case "browsers":
      return simpleRequest({ type: "browsers" }, flags, renderBrowsers);
    case "pages":
      return simpleRequest(
        { type: "pages", source: flags.connect !== undefined || flags.browser ? sourceFromFlags(flags, await loadConfigAsync()) : undefined },
        flags,
        renderPages,
      );
    case "stop":
      return simpleRequest({ type: "stop", browser: command.name }, flags, (p) => {
        const d = p as { stopped: number; daemon?: boolean };
        if (d.daemon) return `stopped ${d.stopped} browser(s) and the daemon\n`;
        return d.stopped > 0 ? `stopped ${d.stopped} browser(s)\n` : `no browser named "${command.name}" is running\n`;
      });
    case "script":
      return runScriptCommand(flags, command.file);
  }
}

/* ------------------------------------------------------------------ */

function sourceFromFlags(flags: GlobalFlags, config: DoobieConfig): BrowserSourceSpec {
  const insecure = (flags.ignoreHttpsErrors ?? config.ignoreHttpsErrors) ? { ignoreHTTPSErrors: true } : {};
  if (flags.connect !== undefined) {
    if (flags.connect.startsWith("unix:") || flags.connect.startsWith("pipe:")) return { kind: "socket", path: flags.connect };
    return { kind: "cdp", url: flags.connect, ...insecure };
  }
  const headless = flags.headless ?? config.headless ?? false;
  return { kind: "launch", name: flags.browser ?? "default", headless, ...insecure };
}

async function readScript(flags: GlobalFlags, file?: string): Promise<{ script: string; name: string } | null> {
  if (flags.eval !== undefined) return { script: flags.eval, name: "<eval>" };
  if (file) {
    const abs = resolvePath(file);
    let script: string;
    try {
      script = await Bun.file(abs).text();
    } catch (err) {
      throw new UsageError(`cannot read ${file}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }
    return { script, name: basename(abs) };
  }
  if (stdinIsTTY()) return null;
  return { script: await Bun.stdin.text(), name: "<stdin>" };
}

async function runScriptCommand(flags: GlobalFlags, file?: string): Promise<number> {
  let src: { script: string; name: string } | null;
  try {
    src = await readScript(flags, file);
  } catch (err) {
    if (err instanceof UsageError) {
      writeErr(`doobie: ${err.message}\n`);
      return EXIT_USAGE;
    }
    throw err;
  }
  if (!src) {
    out(helpText());
    return EXIT_USAGE;
  }
  const config = await loadConfigAsync();
  const timeoutSeconds = flags.timeout ?? config.timeout ?? DEFAULTS.timeoutSeconds;
  let idleTimeoutMs: number;
  try {
    idleTimeoutMs = resolveIdleTimeoutMs(flags.idleTimeout, config);
  } catch (err) {
    writeErr(`doobie: ${(err as Error).message}\n`);
    return EXIT_USAGE;
  }
  const id = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const req: RunRequest = {
    type: "run",
    id,
    script: src.script,
    scriptName: src.name,
    source: sourceFromFlags(flags, config),
    timeoutMs: Math.round(timeoutSeconds * 1000),
    idleTimeoutMs,
    quietPage: flags.quietPage,
    cwd: process.cwd(),
  };

  let exitCode = EXIT_ERROR;
  const sink = new OutputSink({ cap: !flags.noCap, runId: id, out, err: writeErr });
  const onFrame = (f: Frame) => {
    if (flags.json) {
      out(JSON.stringify(f) + "\n");
      if (f.type === "done") exitCode = f.exitCode;
      return;
    }
    switch (f.type) {
      case "stdout":
        sink.write("stdout", f.data);
        break;
      case "stderr":
        sink.write("stderr", f.data);
        break;
      case "image":
        sink.write("stdout", `[image] ${f.path} (${f.width}x${f.height})\n`);
        break;
      case "result":
        sink.write("stdout", f.value.endsWith("\n") ? f.value : f.value + "\n");
        break;
      case "error": {
        let text = `${f.name}: ${f.message}\n`;
        if (f.stack) text += f.stack + "\n";
        if (f.pages && f.pages.length > 0) {
          for (const p of f.pages) text += `[page${p.name ? " " + p.name : ""}] ${p.url}${p.title ? ` "${p.title}"` : ""}\n`;
        }
        sink.write("stderr", text);
        break;
      }
      case "done":
        exitCode = f.exitCode;
        break;
      case "data":
        break;
    }
  };
  try {
    await sendRequest(req, { onFrame, idleTimeoutMs: req.timeoutMs + 15_000, killOnIdle: true });
  } catch (err) {
    sink.finish();
    writeErr(`doobie: ${(err as Error).message}\n`);
    return EXIT_ERROR;
  }
  sink.finish();
  return exitCode;
}

async function simpleRequest(
  req: Parameters<typeof sendRequest>[0],
  flags: GlobalFlags,
  render: (payload: unknown) => string,
): Promise<number> {
  let exitCode = EXIT_ERROR;
  let payload: unknown = undefined;
  try {
    await sendRequest(req, {
      idleTimeoutMs: 30_000,
      onFrame: (f) => {
        if (flags.json) {
          out(JSON.stringify(f) + "\n");
        }
        if (f.type === "data") payload = f.payload;
        else if (f.type === "error" && !flags.json) writeErr(`${f.name}: ${f.message}\n`);
        else if (f.type === "done") exitCode = f.exitCode;
      },
    });
  } catch (err) {
    writeErr(`doobie: ${(err as Error).message}\n`);
    return EXIT_ERROR;
  }
  if (!flags.json && payload !== undefined) out(render(payload));
  return exitCode;
}

function renderStatus(p: unknown): string {
  const s = p as StatusPayload;
  const lines = [
    `daemon   pid ${s.pid}, v${s.version}, up ${formatUptime(s.uptimeMs)}`,
    `socket   ${s.socketPath}`,
    `log      ${s.logPath}`,
    `runs     ${s.activeRuns} active`,
    `browsers ${s.browsers.length}`,
  ];
  for (const b of s.browsers) lines.push("  " + describeBrowser(b));
  if (s.logTail.length > 0) {
    lines.push("log tail:");
    for (const l of s.logTail.slice(-8)) lines.push("  " + l);
  }
  return lines.join("\n") + "\n";
}

function renderBrowsers(p: unknown): string {
  const list = p as BrowserInfo[];
  if (list.length === 0) return "no browsers running\n";
  return list.map(describeBrowser).join("\n") + "\n";
}

function describeBrowser(b: BrowserInfo): string {
  const mode = b.kind === "launch" ? (b.headless ? "headless" : "headed") : b.kind;
  const idle = `idle ${formatUptime(b.idleMs)}` + (b.idleTimeoutMs > 0 && b.kind === "launch" ? `/${formatDuration(b.idleTimeoutMs)}` : "");
  return `${b.key}  ${mode}  ${b.connected ? "connected" : "disconnected"}  ${b.pages} page(s)  ${idle}`;
}

function renderPages(p: unknown): string {
  const list = p as PagesPayload[];
  if (list.length === 0) return "no browsers running\n";
  const out: string[] = [];
  for (const b of list) {
    out.push(`${b.browser}:`);
    if (b.pages.length === 0) out.push("  (no pages)");
    for (const pg of b.pages) out.push(`  ${pg.id}  ${pg.name ?? "-"}  ${pg.url}${pg.title ? `  "${pg.title}"` : ""}`);
  }
  return out.join("\n") + "\n";
}

function formatUptime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export function exitCodeForName(name: string): number {
  return name === "TimeoutError" ? EXIT_TIMEOUT : EXIT_ERROR;
}

/* ------------------------------------------------------------------ */

export function runCli(): void {
  main(process.argv.slice(2)).then(
    (code) => {
      flushAll();
      process.exit(code);
    },
    (e) => {
      writeErr(`doobie: ${(e as Error)?.stack ?? String(e)}\n`);
      flushAll();
      process.exit(EXIT_ERROR);
    },
  );
}

if (import.meta.main) runCli();
