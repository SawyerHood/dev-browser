# dev-browser

Browser automation CLI for coding agents: Puppeteer scripts, named pages, snapshot refs, one warm daemon.

An agent (Claude Code, Codex, ...) pipes a short JavaScript snippet into `dev-browser`; the snippet runs against a real Chrome
that stays open between calls. Pages have names (`browser.getPage("checkout")`) so each step resumes where the last one
stopped. `page.snapshot()` returns an ARIA tree with refs (`e12`), and `page.click("ref/e12")` acts on them. Typical
warm call: about 15 ms.

```bash
dev-browser <<'EOF'
const page = await browser.getPage("main");
await page.goto("https://example.com");
await page.snapshot({ interactive: true })
EOF
# - heading "Example Domain" [level=1] [ref=e3]
# - link "Learn more" [ref=e6]:
#   - /url: https://iana.org/domains/example

dev-browser -e 'const p = await browser.getPage("main"); await p.click("ref/e6"); await p.waitForLoad(); p.url()'
```

## Install

```bash
npm install -g dev-browser          # or download a binary from GitHub Releases
dev-browser install                 # only if the first run says "No Chrome found" (downloads Chrome for Testing, ~150 MB)
dev-browser install-skill           # optional: SKILL.md for Claude Code / Codex / ~/.agents
```

macOS and Linux. Windows is not yet supported. Requires nothing else at runtime: the binary embeds Bun, Puppeteer and
the zip extractor used by `dev-browser install` (no `unzip` needed); the npm package has no runtime dependencies, its
postinstall only downloads the binary for your platform. Snap-packaged Chromium on Ubuntu cannot read `~/.dev-browser/v1`;
use `dev-browser install` or `DEV_BROWSER_CHROME` there.

If your package manager blocks install scripts (`bun add -g dev-browser`, pnpm before `pnpm approve-builds`, `npm --ignore-scripts`),
the first `dev-browser` run downloads the binary itself (`dev-browser: downloading binary v...`). To fetch it eagerly instead:
`bun pm -g trust dev-browser`, `pnpm approve-builds -g dev-browser`, or `npm rebuild -g dev-browser`. Behind a mirror set
`DEV_BROWSER_DOWNLOAD_BASE=https://mirror/path/v1.0.0` (must serve `dev-browser-<os>-<arch>` and `SHA256SUMS`); with
`DEV_BROWSER_SKIP_DOWNLOAD=1` nothing is downloaded and you place the binary at `<pkg>/bin/dev-browser-bin` yourself.

## Quick start

```bash
dev-browser --help                  # the full agent-facing guide (also docs/help.md)
dev-browser help workflow           # one topic
dev-browser pages                   # open tabs and their names
dev-browser --headless -e 'const p = await browser.getPage("x"); await p.goto("https://news.ycombinator.com"); await p.title()'
dev-browser --connect               # attach to a Chrome started with `dev-browser chrome` (real profile, Google sign-in works)
dev-browser stop                    # close browsers and the daemon
```

## Upgrading to 1.0

Version 1.0 replaces the 0.2 Playwright/QuickJS implementation with the faster Puppeteer/Bun implementation developed
as doobie. State lives under `~/.dev-browser/v1`, so it cannot collide with a running 0.2 daemon or its incompatible
profiles. Existing 0.2 state remains untouched.

To copy durable state from doobie, stop it first and run:

```bash
doobie stop
dev-browser migrate-from-doobie
```

The migration copies state into an empty v1 directory and leaves `~/.doobie` unchanged. Existing scripts must move
from Playwright helpers such as `snapshotForAI()` and `getByRef()` to `snapshot()` and `ref/eN`; the runtime is a
`node:vm` isolation context, not a security sandbox. Windows and musl Linux binaries are not available in 1.0.

Scripts get `browser` (`getPage`, `newPage`, `listPages`, `closePage`), `console`, `saveFile`/`readFile` (jailed to
`~/.dev-browser/v1/tmp`) and the full Puppeteer `Page` API plus `page.snapshot`, `page.ref`, `page.shot`, `page.waitForLoad`,
`page.fill`. Top-level `await` works and the last expression is the return value. Everything else is in
[docs/help.md](docs/help.md).

## MCP

`dev-browser mcp --headless` is a stdio MCP server exposing `dev_browser_run`, `dev_browser_pages`, `dev_browser_browsers`, `dev_browser_stop` and `dev_browser_help` over the same daemon (`claude mcp add dev-browser -- dev-browser mcp --headless`).

## How it works

- **Thin client, warm daemon.** The `dev-browser` binary connects to `~/.dev-browser/v1/daemon.sock`, sends one request, streams the
  output, exits. If no daemon is running it starts one. The daemon keeps Chrome, Puppeteer, and page handles warm and
  exits 15 minutes after its last browser closes.
- **Puppeteer + `node:vm`.** Each script is wrapped in an async function and run in a fresh `vm` context inside the
  daemon with real Puppeteer objects. This gives clean globals and fast startup; it is not a security boundary.
- **Named pages.** `getPage(name)` maps a name to a Chrome tab (`~/.dev-browser/v1/pages/`), so state survives across scripts
  and even daemon restarts. Names are scoped to one browser key (`default`, `default:headless`, `work`, ...). Launched
  browsers use persistent profiles under `~/.dev-browser/v1/browsers/<name>/profile` (headless: `profile-headless`); headed
  and headless are separate Chromes with separate profiles.
- **Snapshot refs.** An in-page script renders an ARIA YAML tree and assigns stable refs to every visible element that
  receives pointer events (`interactive: true` prunes to controls plus headings/landmarks); `ref/e12` is a registered
  Puppeteer query handler, so it works in every selector API.
- **One deadline.** `--timeout` (default 30 s) bounds connect + script + teardown; Puppeteer waits default to 5 s
  (navigation 15 s); a script that outlives the deadline is stopped at its next page call. Exit codes: 0 ok, 1 error,
  2 usage, 124 deadline.
- **Attach, not just launch.** `--connect` attaches to any Chrome over CDP (auto-discovery, port, http, ws, or a raw
  CDP unix socket) and only touches the tabs a script asks for (the user's other tabs keep their dialogs and scripts);
  `dev-browser chrome` starts your installed Chrome with remote debugging on a dedicated profile and verifies it came up.
- **Concurrent scripts.** Scripts run in parallel; only launch/connect, page creation and input on different tabs of one
  browser (a bring-to-front lock, since background tabs do not process input) are serialized. Two scripts on the same
  named page interleave. Per-script state (default timeouts, request interception) is reset when the script ends.

## Performance

Measured on Linux, headless, warm daemon, medians of 9 runs (`bun run build && bun run bench/run.ts --runs 9`):

| scenario                              | time     |
| ------------------------------------- | -------- |
| `dev-browser -e '1+1'` (warm)              | ~13 ms   |
| `getPage("x")` + `page.title()` (warm)| ~14 ms   |
| `page.snapshot()` (SERP-like page, in-script) | ~18 ms |
| `page.shot()` (viewport, in-script)   | ~36 ms   |
| cold start (spawn daemon + launch headless Chrome) | ~280 ms |

## Development

```bash
bun install
bun run dev -- -e '1+1'        # run from source
bun test                       # real headless Chrome tests
bun run build                  # build/daemon.js + dist/dev-browser (single binary)
```

Design decisions and rationale: [docs/design-decisions.md](docs/design-decisions.md). Agent-facing reference:
[docs/help.md](docs/help.md) (embedded verbatim in `dev-browser --help`).

## Releasing

See [RELEASING.md](RELEASING.md) for release-candidate testing, the historical `v1.0.0` tag cleanup, trusted npm
publishing, and post-release verification.

## License

MIT
