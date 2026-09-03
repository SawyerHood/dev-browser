/**
 * `dev-browser mcp`: a Model Context Protocol server over stdio that exposes the
 * same request/frame contract the CLI uses. Hand-rolled JSON-RPC 2.0 (no SDK)
 * so the binary stays dependency-free.
 *
 * Tools:
 *   dev_browser_run      { script, browser?, headless?, connect?, timeout? }  -> text (+ image blocks for page.shot())
 *   dev_browser_pages    { browser?, connect? }
 *   dev_browser_browsers {}
 *   dev_browser_stop     { browser? }
 *   dev_browser_help     { topic? }
 *
 * Flags given to `dev-browser mcp` (-b, --headless, --connect, -t, --idle-timeout,
 * --quiet-page) are the defaults for every tool call.
 */
import * as fs from "node:fs";
import type { GlobalFlags } from "../cli/args.ts";
import { sendRequest } from "../cli/client.ts";
import { sourceFromFlags } from "../cli/main.ts";
import { helpText, topicText } from "../cli/help.ts";
import { DEFAULTS, loadConfig, resolveIdleTimeoutMs } from "../shared/config.ts";
import { VERSION } from "../shared/version.ts";
import type { Frame, RunRequest, Request, PagesPayload, BrowserInfo } from "../shared/protocol.ts";
import { EXIT_OK } from "../shared/protocol.ts";

const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const TOOLS = [
  {
    name: "dev_browser_run",
    description:
      "Run a JavaScript snippet in dev-browser's browser runtime (Puppeteer). Globals: browser.getPage(name) (persistent named tabs), page.snapshot(), page.ref('e5') / 'ref/e5' selectors, page.shot(), page.waitForLoad(), page.fill(), saveFile/readFile. The last expression is the return value. Returns console output, the return value, errors, and page.shot() images.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "JavaScript (top-level await allowed). Last expression is returned." },
        browser: { type: "string", description: "Named browser profile (default \"default\")." },
        headless: { type: "boolean", description: "Launch headless (default: the server's --headless flag or config)." },
        connect: { type: "string", description: "Attach to a running Chrome: auto | http://host:port | ws://... | unix:/path" },
        timeout: { type: "number", description: "Deadline in seconds for the whole run (default 30)." },
      },
      required: ["script"],
    },
  },
  {
    name: "dev_browser_pages",
    description: "List open pages (tabs) with target ids, names, URLs and titles.",
    inputSchema: { type: "object", properties: { browser: { type: "string" }, connect: { type: "string" } } },
  },
  { name: "dev_browser_browsers", description: "List running browsers managed by the dev-browser daemon.", inputSchema: { type: "object", properties: {} } },
  {
    name: "dev_browser_stop",
    description: "Stop one browser by name/key, or everything (and the daemon) when no browser is given.",
    inputSchema: { type: "object", properties: { browser: { type: "string" } } },
  },
  {
    name: "dev_browser_help",
    description: "The dev-browser usage guide (or one topic: quickstart, workflow, scripts, pages, snapshot, refs, screenshots, waiting, forms, errors, output, connect, chrome, config, json, examples, tips).",
    inputSchema: { type: "object", properties: { topic: { type: "string" } } },
  },
];

function textOf(s: string): Content {
  return { type: "text", text: s };
}

async function callTool(name: string, args: Record<string, unknown>, defaults: GlobalFlags): Promise<{ content: Content[]; isError?: boolean }> {
  const config = loadConfig();
  const flags: GlobalFlags = {
    ...defaults,
    browser: typeof args.browser === "string" ? args.browser : defaults.browser,
    headless: typeof args.headless === "boolean" ? args.headless : defaults.headless,
    connect: typeof args.connect === "string" ? args.connect : defaults.connect,
    timeout: typeof args.timeout === "number" ? args.timeout : defaults.timeout,
  };
  switch (name) {
    case "dev_browser_help":
      return { content: [textOf(typeof args.topic === "string" ? topicText(args.topic) : helpText())] };
    case "dev_browser_run": {
      if (typeof args.script !== "string") return { content: [textOf("script (string) is required")], isError: true };
      const req: RunRequest = {
        type: "run",
        id: `mcp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
        script: args.script,
        scriptName: "<mcp>",
        source: sourceFromFlags(flags, config),
        timeoutMs: Math.round((flags.timeout ?? config.timeout ?? DEFAULTS.timeoutSeconds) * 1000),
        idleTimeoutMs: resolveIdleTimeoutMs(flags.idleTimeout, config),
        quietPage: flags.quietPage,
        cwd: process.cwd(),
      };
      let stdout = "";
      let stderr = "";
      let result: string | undefined;
      const images: Array<{ path: string; width: number; height: number }> = [];
      let exitCode = 1;
      await sendRequest(req, {
        idleTimeoutMs: req.timeoutMs + 15_000,
        killOnIdle: true,
        onFrame: (f: Frame) => {
          switch (f.type) {
            case "stdout": stdout += f.data; break;
            case "stderr": stderr += f.data; break;
            case "result": result = f.value; break;
            case "image": images.push({ path: f.path, width: f.width, height: f.height }); break;
            case "error": {
              let t = `${f.name}: ${f.message}\n`;
              if (f.stack) t += f.stack + "\n";
              for (const p of f.pages ?? []) t += `[page${p.name ? " " + p.name : ""}] ${p.url}${p.title ? ` "${p.title}"` : ""}\n`;
              stderr += t;
              break;
            }
            case "done": exitCode = f.exitCode; break;
            default: break;
          }
        },
      });
      const content: Content[] = [];
      let text = stdout;
      if (result !== undefined) text += (text && !text.endsWith("\n") ? "\n" : "") + result + "\n";
      for (const im of images) text += `[image] ${im.path} (${im.width}x${im.height})\n`;
      if (stderr) text += (text && !text.endsWith("\n") ? "\n" : "") + stderr;
      if (exitCode !== EXIT_OK) text += `(exit ${exitCode})\n`;
      content.push(textOf(text.length > 0 ? text : "(no output)"));
      for (const im of images) {
        try {
          const data = fs.readFileSync(im.path).toString("base64");
          content.push({ type: "image", data, mimeType: im.path.endsWith(".png") ? "image/png" : "image/jpeg" });
        } catch {
          /* file gone */
        }
      }
      return { content, isError: exitCode !== EXIT_OK };
    }
    case "dev_browser_pages":
    case "dev_browser_browsers":
    case "dev_browser_stop": {
      const req: Request =
        name === "dev_browser_pages"
          ? { type: "pages", source: flags.connect !== undefined || flags.browser ? sourceFromFlags(flags, config) : undefined }
          : name === "dev_browser_browsers"
            ? { type: "browsers" }
            : { type: "stop", browser: typeof args.browser === "string" ? args.browser : undefined };
      let payload: unknown;
      let error = "";
      let exitCode = 1;
      await sendRequest(req, {
        idleTimeoutMs: 30_000,
        onFrame: (f) => {
          if (f.type === "data") payload = f.payload;
          else if (f.type === "error") error += `${f.name}: ${f.message}\n`;
          else if (f.type === "done") exitCode = f.exitCode;
        },
      });
      if (error) return { content: [textOf(error)], isError: true };
      if (name === "dev_browser_pages") {
        const list = (payload as PagesPayload[]) ?? [];
        const lines: string[] = [];
        for (const b of list) {
          lines.push(`${b.browser}:`);
          for (const p of b.pages) lines.push(`  ${p.id}  ${p.name ?? "-"}  ${p.url}${p.title ? `  "${p.title}"` : ""}`);
        }
        return { content: [textOf(lines.length ? lines.join("\n") : "no browsers running")], isError: exitCode !== EXIT_OK };
      }
      if (name === "dev_browser_browsers") {
        const list = (payload as BrowserInfo[]) ?? [];
        return {
          content: [textOf(list.length ? list.map((b) => `${b.key}  ${b.kind === "launch" ? (b.headless ? "headless" : "headed") : b.kind}  ${b.connected ? "connected" : "disconnected"}  ${b.pages} page(s)`).join("\n") : "no browsers running")],
        };
      }
      return { content: [textOf(JSON.stringify(payload))], isError: exitCode !== EXIT_OK };
    }
    default:
      return { content: [textOf(`unknown tool ${name}`)], isError: true };
  }
}

export async function mcpMain(flags: GlobalFlags): Promise<number> {
  const writer = Bun.stdout.writer();
  const send = (msg: object) => {
    writer.write(JSON.stringify(msg) + "\n");
    writer.flush();
  };
  const reply = (id: JsonRpcRequest["id"], result: unknown) => send({ jsonrpc: "2.0", id, result });
  const fail = (id: JsonRpcRequest["id"], code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

  let buf = "";
  const handle = async (line: string) => {
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      fail(null, -32700, "parse error");
      return;
    }
    const id = msg.id ?? null;
    const isNotification = msg.id === undefined;
    try {
      switch (msg.method) {
        case "initialize":
          reply(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "dev-browser", version: VERSION },
            instructions:
              "Drive a browser with short Puppeteer scripts via dev_browser_run. Workflow: getPage(name) -> goto -> page.snapshot({interactive:true}) -> act via 'ref/eN' selectors -> verify with a tracked snapshot or page.shot(). Call dev_browser_help for the full guide.",
          });
          return;
        case "notifications/initialized":
        case "notifications/cancelled":
          return;
        case "ping":
          reply(id, {});
          return;
        case "tools/list":
          reply(id, { tools: TOOLS });
          return;
        case "tools/call": {
          const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          const res = await callTool(String(params.name ?? ""), params.arguments ?? {}, flags);
          reply(id, res);
          return;
        }
        default:
          if (!isNotification) fail(id, -32601, `method not found: ${msg.method}`);
      }
    } catch (err) {
      if (!isNotification) fail(id, -32603, (err as Error)?.message ?? String(err));
    }
  };

  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) await handle(line);
    }
  }
  return EXIT_OK;
}
