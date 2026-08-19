/**
 * Socket source: raw CDP JSON lines over a Unix socket. We stand up a proxy
 * that bridges lines <-> Chrome's devtools websocket, the way a host app
 * (e.g. bb) would expose its own Chromium, then drive it with --connect unix:.
 */
import { test, expect, afterAll, beforeAll } from "bun:test";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBrowser, closeBrowser } from "./helpers/browser.ts";
import { makeCliEnv, type CliEnv } from "./helpers/cli.ts";

let cli: CliEnv;
let proxy: net.Server;
let sockPath: string;

beforeAll(async () => {
  cli = makeCliEnv("doobie-sock-");
  const browser = await getBrowser();
  const wsUrl = browser.wsEndpoint();
  sockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "doobie-cdp-")), "cdp.sock");
  proxy = net.createServer((sock) => {
    const ws = new WebSocket(wsUrl);
    let buf = "";
    const pending: string[] = [];
    ws.onopen = () => {
      for (const m of pending) ws.send(m);
      pending.length = 0;
    };
    ws.onmessage = (ev) => {
      sock.write(String(ev.data) + "\n");
    };
    ws.onclose = () => sock.end();
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        if (ws.readyState === WebSocket.OPEN) ws.send(line);
        else pending.push(line);
      }
    });
    sock.on("close", () => ws.close());
    sock.on("error", () => ws.close());
  });
  await new Promise<void>((r) => proxy.listen(sockPath, r));
});

afterAll(async () => {
  await cli.cleanup();
  proxy.close();
  await closeBrowser();
});

test("--connect unix:/path drives a browser over raw CDP lines", async () => {
  const r = await cli.run([
    "--connect",
    `unix:${sockPath}`,
    "-e",
    'const p = await browser.getPage("sock"); await p.setContent("<title>via socket</title>"); await p.title()',
  ]);
  expect(r.stderr).toBe("");
  expect(r.stdout.trim()).toBe("via socket");
  expect(r.code).toBe(0);
  const b = await cli.run(["browsers"]);
  expect(b.stdout).toContain(`socket:unix:${sockPath}`);
});
