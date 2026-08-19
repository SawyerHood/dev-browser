# doobie

Browser automation CLI for coding agents: Puppeteer scripts, named pages, snapshot refs, one warm daemon.

An agent (Claude Code, Codex, ...) pipes a short JavaScript snippet into `doobie`; the snippet runs against a real Chrome
that stays open between calls. Pages have names (`browser.getPage("checkout")`) so each step resumes where the last one
stopped. `page.snapshot()` returns an ARIA tree with refs (`e12`), and `page.click("ref/e12")` acts on them. Typical
warm call: about 25 ms.

```bash
doobie <<'EOF'
const page = await browser.getPage("main");
await page.goto("https://example.com");
await page.snapshot({ interactive: true })
EOF
# - heading "Example Domain" [level=1]
# - link "More information..." [ref=e1]:
#   - /url: https://www.iana.org/domains/example

doobie -e 'const p = await browser.getPage("main"); await p.click("ref/e1"); await p.waitForLoad(); p.url()'
```

## Install

```bash
npm install -g doobie          # or download a binary from GitHub Releases
doobie install                 # only if no Chrome/Chromium/Edge/Brave is installed (downloads Chrome for Testing)
doobie install-skill           # optional: SKILL.md for Claude Code / Codex / ~/.agents
```

macOS and Linux. Windows is not yet supported. Requires nothing else at runtime: the binary embeds Bun and Puppeteer.

## Quick start

```bash
doobie --help                  # the full agent-facing guide (also docs/help.md)
doobie help workflow           # one topic
doobie pages                   # open tabs and their names
doobie --headless -e 'const p = await browser.getPage("x"); await p.goto("https://news.ycombinator.com"); await p.title()'
doobie --connect               # attach to a Chrome started with `doobie chrome` (real profile, Google sign-in works)
doobie stop                    # close browsers and the daemon
```

Scripts get `browser` (`getPage`, `newPage`, `listPages`, `closePage`), `console`, `saveFile`/`readFile` (jailed to
`~/.doobie/tmp`) and the full Puppeteer `Page` API plus `page.snapshot`, `page.ref`, `page.shot`, `page.waitForLoad`,
`page.fill`. Top-level `await` works and the last expression is the return value. Everything else is in
[docs/help.md](docs/help.md).

## How it works

- **Thin client, warm daemon.** The `doobie` binary connects to `~/.doobie/daemon.sock`, sends one request, streams the
  output, exits. If no daemon is running it starts one. The daemon keeps Chrome, Puppeteer, and page handles warm and
  exits 15 minutes after its last browser closes.
- **Puppeteer + `node:vm`.** Each script is wrapped in an async function and run in a fresh `vm` context inside the
  daemon with real Puppeteer objects. This gives clean globals and fast startup; it is not a security boundary.
- **Named pages.** `getPage(name)` maps a name to a Chrome tab (`~/.doobie/pages/`), so state survives across scripts
  and even daemon restarts. Launched browsers use persistent profiles under `~/.doobie/browsers/<name>`.
- **Snapshot refs.** An in-page script renders an ARIA YAML tree and assigns stable refs to visible interactive
  elements; `ref/e12` is a registered Puppeteer query handler, so it works in every selector API.
- **One deadline.** `--timeout` (default 30 s) bounds connect + script + teardown; per-action defaults are 5 s
  (actions) and 15 s (navigation). Exit codes: 0 ok, 1 error, 2 usage, 124 deadline.
- **Attach, not just launch.** `--connect` attaches to any Chrome over CDP (auto-discovery, port, http, ws, or a raw
  CDP unix socket); `doobie chrome` starts your installed Chrome with remote debugging on a dedicated profile.

## Performance

Measured on Linux, headless, warm daemon (see `bun run bench`):

| scenario                              | time     |
| ------------------------------------- | -------- |
| `doobie -e '1+1'` (warm)              | ~24 ms   |
| `getPage("x")` + `page.title()` (warm)| ~25 ms   |
| cold start (spawn daemon, no Chrome)  | ~360 ms  |

## Development

```bash
bun install
bun run dev -- -e '1+1'        # run from source
bun test                       # real headless Chrome tests
bun run build                  # build/daemon.js + dist/doobie (single binary)
```

Design decisions and rationale: [docs/design-decisions.md](docs/design-decisions.md). Agent-facing reference:
[docs/help.md](docs/help.md) (embedded verbatim in `doobie --help`).

## License

MIT
