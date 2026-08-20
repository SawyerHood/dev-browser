/**
 * Hand-written argument parser (no deps; the client must start fast).
 *
 *   doobie [flags] < script.js
 *   doobie [flags] -e 'code'
 *   doobie [flags] run FILE
 *   doobie pages | browsers | status | stop [NAME] | install | install-skill [...] | chrome [...] | help [topic] | daemon
 */

export interface GlobalFlags {
  browser?: string;
  /** undefined = not given; "auto" = bare --connect; otherwise URL */
  connect?: string;
  headless?: boolean;
  /** --ignore-https-errors: accept invalid TLS certificates (self-signed dev servers). */
  ignoreHttpsErrors?: boolean;
  /** seconds */
  timeout?: number;
  json: boolean;
  idleTimeout?: string;
  quietPage: boolean;
  noCap: boolean;
  eval?: string;
  help: boolean;
  version: boolean;
}

export type Command =
  | { kind: "script"; file?: string }
  | { kind: "pages" }
  | { kind: "browsers" }
  | { kind: "status" }
  | { kind: "stop"; name?: string }
  | { kind: "install"; args: string[] }
  | { kind: "install-skill"; args: string[] }
  | { kind: "chrome"; args: string[] }
  | { kind: "help"; topic?: string }
  | { kind: "daemon" }
  | { kind: "mcp" };

export interface ParsedArgs {
  flags: GlobalFlags;
  command: Command;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const PASSTHROUGH = new Set(["install", "install-skill", "chrome"]);
const SUBCOMMANDS = new Set(["run", "pages", "browsers", "status", "stop", "install", "install-skill", "chrome", "help", "daemon", "mcp"]);

function looksLikeConnectValue(v: string | undefined): boolean {
  if (!v) return false;
  if (v.startsWith("-")) return false;
  if (SUBCOMMANDS.has(v)) return false;
  return /^(auto|https?:\/\/|wss?:\/\/|unix:|pipe:|\d+$|[\w.-]+:\d+$)/.test(v);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: GlobalFlags = { json: false, quietPage: false, noCap: false, help: false, version: false };
  let command: Command | null = null;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    const takeValue = (name: string, allowDash = false): string => {
      if (next === undefined || (!allowDash && next.startsWith("-") && next !== "-")) {
        throw new UsageError(`${name} requires a value`);
      }
      i++;
      return next;
    };
    // Subcommands with their own option parser take everything after them verbatim.
    if (command && PASSTHROUGH.has(command.kind)) {
      rest.push(a);
      continue;
    }
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      argv.splice(i + 1, 0, a.slice(eq + 1));
      argv[i] = a.slice(0, eq);
      i--;
      continue;
    }
    switch (a) {
      case "-b":
      case "--browser":
        flags.browser = takeValue(a);
        break;
      case "-c":
      case "--connect":
        if (looksLikeConnectValue(next)) {
          flags.connect = next!;
          i++;
        } else {
          flags.connect = "auto";
        }
        break;
      case "--headless":
        flags.headless = true;
        break;
      case "--headed":
        flags.headless = false;
        break;
      case "--ignore-https-errors":
        flags.ignoreHttpsErrors = true;
        break;
      case "-t":
      case "--timeout": {
        const v = Number(takeValue(a));
        if (!Number.isFinite(v) || v < 1) throw new UsageError("--timeout must be a number of seconds >= 1");
        flags.timeout = v;
        break;
      }
      case "--json":
        flags.json = true;
        break;
      case "--idle-timeout":
        flags.idleTimeout = takeValue(a);
        break;
      case "--quiet-page":
        flags.quietPage = true;
        break;
      case "--no-cap":
        flags.noCap = true;
        break;
      case "-e":
      case "--eval":
        flags.eval = takeValue(a, true); // code may start with "-" (e.g. -1)
        break;
      case "-h":
      case "--help":
        flags.help = true;
        break;
      case "-V":
      case "--version":
        flags.version = true;
        break;
      default:
        if (a.startsWith("-") && a !== "-") throw new UsageError(`unknown flag ${a}`);
        if (!command) {
          switch (a) {
            case "run": {
              const file = next;
              if (!file) throw new UsageError("run requires a FILE");
              i++;
              command = { kind: "script", file };
              break;
            }
            case "pages":
              command = { kind: "pages" };
              break;
            case "browsers":
              command = { kind: "browsers" };
              break;
            case "status":
              command = { kind: "status" };
              break;
            case "stop":
              command = { kind: "stop", name: next && !next.startsWith("-") ? (i++, next) : undefined };
              break;
            case "install":
              command = { kind: "install", args: [] };
              break;
            case "install-skill":
              command = { kind: "install-skill", args: [] };
              break;
            case "chrome":
              command = { kind: "chrome", args: [] };
              break;
            case "help":
              command = { kind: "help", topic: next && !next.startsWith("-") ? (i++, next) : undefined };
              break;
            case "daemon":
              command = { kind: "daemon" };
              break;
            case "mcp":
              command = { kind: "mcp" };
              break;
            default:
              throw new UsageError(`unknown command "${a}". Run doobie --help.`);
          }
        } else {
          throw new UsageError(`unexpected argument "${a}"`);
        }
    }
  }
  if (!command) command = { kind: "script" };
  if (command.kind === "install" || command.kind === "install-skill" || command.kind === "chrome") command.args = rest;
  return { flags, command };
}
