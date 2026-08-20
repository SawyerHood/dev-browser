/**
 * `doobie mcp`: stdio JSON-RPC server over the same frame contract.
 */
import { test, expect, afterAll, beforeAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
let home: string;
let proc: import("bun").Subprocess<"pipe", "pipe", "inherit">;
let reader: ReadableStreamDefaultReader<Uint8Array>;
let buf = "";
const pending = new Map<number, (v: any) => void>();
let nextId = 1;

async function pump(): Promise<void> {
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    }
  }
}

function rpc(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  const p = new Promise<any>((resolve) => pending.set(id, resolve));
  (proc.stdin as import("bun").FileSink).write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return p;
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "doobie-mcp-"));
  const env = { ...process.env, DOOBIE_HOME: home } as Record<string, string>;
  delete env.NODE_PATH;
  proc = Bun.spawn([process.execPath, path.join(ROOT, "src/cli/main.ts"), "mcp", "--headless"], {
    cwd: ROOT,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  void pump();
});

afterAll(async () => {
  try {
    await rpc("tools/call", { name: "doobie_stop", arguments: {} });
  } catch {
    /* ignore */
  }
  proc.kill();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(home, { recursive: true, force: true });
});

test("initialize + tools/list", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  expect(init.result.serverInfo.name).toBe("doobie");
  expect(init.result.capabilities.tools).toBeDefined();
  (proc.stdin as import("bun").FileSink).write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await rpc("tools/list", {});
  const names = list.result.tools.map((t: any) => t.name);
  expect(names).toEqual(["doobie_run", "doobie_pages", "doobie_browsers", "doobie_stop", "doobie_help"]);
}, 20_000);

test("doobie_run returns text + image content, errors set isError", async () => {
  const r = await rpc("tools/call", {
    name: "doobie_run",
    arguments: { script: 'const p = await browser.getPage("m"); await p.setContent("<title>mcp</title><h1>hi</h1>"); console.log("log line"); await p.shot({ name: "mcp.jpg" }); await p.title()' },
  });
  expect(r.result.isError).toBe(false);
  const text = r.result.content.find((c: any) => c.type === "text").text as string;
  expect(text).toContain("log line");
  expect(text).toContain("mcp\n");
  expect(text).toContain("[image]");
  const img = r.result.content.find((c: any) => c.type === "image");
  expect(img.mimeType).toBe("image/jpeg");
  expect(img.data.length).toBeGreaterThan(1000);

  const e = await rpc("tools/call", { name: "doobie_run", arguments: { script: "throw new TypeError('boom')" } });
  expect(e.result.isError).toBe(true);
  expect(e.result.content[0].text).toContain("TypeError: boom");

  const pages = await rpc("tools/call", { name: "doobie_pages", arguments: {} });
  expect(pages.result.content[0].text).toContain("  m  ");
  const help = await rpc("tools/call", { name: "doobie_help", arguments: { topic: "refs" } });
  expect(help.result.content[0].text).toMatch(/^## refs/);
  const bad = await rpc("nope", {});
  expect(bad.error.code).toBe(-32601);
}, 60_000);
