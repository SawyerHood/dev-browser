/**
 * Tiny fixture HTTP server for tests. Routes are plain strings or handlers.
 *
 *   const srv = await startServer({ "/": "<h1>hi</h1>", "/slow": async () => { await sleep(500); return "ok"; } });
 *   srv.url("/")  -> http://127.0.0.1:PORT/
 *   await srv.stop();
 */
export type RouteHandler = (req: Request) => Response | Promise<Response> | string | Promise<string>;

export interface FixtureServer {
  port: number;
  url(path: string): string;
  stop(): Promise<void>;
  /** Add or replace a route at runtime. */
  set(path: string, handler: string | RouteHandler): void;
  /** Requests seen so far (method + path). */
  hits: string[];
}

export async function startServer(routes: Record<string, string | RouteHandler> = {}): Promise<FixtureServer> {
  const table = new Map<string, string | RouteHandler>(Object.entries(routes));
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      hits.push(`${req.method} ${u.pathname}`);
      const h = table.get(u.pathname);
      if (h === undefined) return new Response("not found", { status: 404 });
      const out = typeof h === "function" ? await h(req) : h;
      if (out instanceof Response) return out;
      return new Response(out, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  return {
    port: server.port!,
    url: (p: string) => `http://127.0.0.1:${server.port}${p.startsWith("/") ? p : "/" + p}`,
    stop: async () => {
      await server.stop(true);
    },
    set: (p, h) => {
      table.set(p, h);
    },
    hits,
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
