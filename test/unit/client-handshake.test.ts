/**
 * Unit tests for the client handshake: a daemon that does not answer hello is not killed by an ordinary
 * request, and the request is never sent before the daemon has answered.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { sendRequest } from "../../src/cli/client.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

test("a request to a daemon that never answers hello is not sent, and the daemon is not killed", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dev-browser-hello-"));
  const prev = { home: process.env.DEV_BROWSER_HOME, socket: process.env.DEV_BROWSER_SOCKET };
  process.env.DEV_BROWSER_HOME = home;
  delete process.env.DEV_BROWSER_SOCKET;
  cleanups.push(() => {
    if (prev.home === undefined) delete process.env.DEV_BROWSER_HOME;
    else process.env.DEV_BROWSER_HOME = prev.home;
    if (prev.socket !== undefined) process.env.DEV_BROWSER_SOCKET = prev.socket;
    fs.rmSync(home, { recursive: true, force: true });
  });

  // A stand-in for a daemon whose event loop is blocked: it accepts the connection but never answers.
  const received: string[] = [];
  const server = net.createServer((sock) => sock.on("data", (c) => received.push(c.toString("utf8"))));
  await new Promise<void>((resolve) => server.listen(path.join(home, "daemon.sock"), resolve));
  cleanups.push(() => server.close());
  // The pid file names a live process standing in for that daemon.
  const daemon = Bun.spawn(["sleep", "30"]);
  cleanups.push(() => daemon.kill());
  fs.writeFileSync(path.join(home, "daemon.pid"), String(daemon.pid));

  const err = await sendRequest({ type: "status" }, { firstFrameTimeoutMs: 300, onFrame: () => {} }).then(
    () => null,
    (e: Error) => e,
  );
  expect(err?.message).toMatch(/did not answer for 0s .*the request was not sent/);
  const frames = received.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string });
  expect(frames.map((f) => f.type)).toEqual(["hello"]);
  expect(daemon.exitCode).toBeNull();
  expect(fs.existsSync(path.join(home, "daemon.sock"))).toBe(true);
});
