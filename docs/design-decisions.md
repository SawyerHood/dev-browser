# doobie — design decisions (grilling session, 2026-08-19)

Source material: `docs/exploration.md` (merged read of dev-browser v0.2.9 and do-browser).
Every item below is a decision the user made. Items marked *(assumed)* are defaults I chose; say so if you want them changed.

## 1. Identity

- Name: **doobie**. CLI `doobie`, npm package `doobie`, state dir `~/.doobie/`, skill name `doobie`.
- New product, new public repo `SawyerHood/doobie`, MIT, single Bun workspace package. `ref/` is git-ignored.
- Platforms: macOS + Linux first. Windows after 1.0. Endpoint abstraction stays pipe-capable.

## 2. Runtime and process model

- Script runtime library: **Puppeteer** (`puppeteer-core`, exact-pinned).
- **Warm daemon + thin client.** Client connects to `~/.doobie/daemon.sock`, sends one request, streams frames, exits.
- **Single Bun binary** (`bun build --compile`) is both client and daemon (`doobie daemon` is the internal entry). A spike verifies Chrome launch + connect + screenshot under Bun first; fallback is a Node daemon with the same client.
- Sandbox: **`node:vm` context inside the daemon**, real Puppeteer objects passed in. Goal is clean globals only; **no security claim**. Watchdog: the client treats a dead heartbeat as a hung daemon and kills/restarts it.
- Concurrency: **scripts run concurrently**; only browser launch/connect and page creation are mutexed. Two scripts on one named page may interleave (documented).
- Browser sources: one `BrowserSource` interface with `launch` (named profile), `cdp` (`--connect auto|http://|ws://`), `socket` (`--connect unix:/path`, raw CDP JSON lines; the hook for the bb in-app browser via `webContents.debugger` later). All three ship in v2.

## 3. Browser and lifetimes

- Headed by default, `--headless` flag, config override. Headed: `viewport: null`; headless: 1280x720. A different mode gets its own instance; no relaunch-on-flag-change.
- Chrome acquisition: detect installed Chrome/Chromium/Edge first; `doobie install` downloads Chrome for Testing via `@puppeteer/browsers` as fallback; `--chrome <path>` / env override *(assumed: `DOOBIE_CHROME`)*.
- `doobie chrome [--profile NAME]` launches the user's real Chrome with `--remote-debugging-port` on a dedicated profile and remembers the port so `--connect auto` finds it (Google sign-in path).
- Browser idle timeout **default 30 min** (launched browsers only; profile persists). Flag > env > config > default.
- Daemon exits after 15 min with no browsers. `doobie stop [NAME]` stops one browser or everything. Daemon auto-starts on the next call.
- Daemon log at `~/.doobie/daemon.log`; `status` shows its tail.
- Anonymous pages are **not** auto-closed. `listPages()` shows them with targetIds.
- Page names: **file map per browser `{name -> targetId}`** under `~/.doobie/`, validated on use; `getPage('<targetId>')` attaches any tab.

## 4. Request contract

- Input: `doobie [flags] < script.js`, `doobie run FILE`, `doobie -e 'code'`. No `--arg`. TTY with no script prints help.
- Eval: parse with acorn; if the last top-level statement is an expression, it becomes the return value; explicit `return` works; top-level `await` works; **never executes twice**.
- Timeouts: `--timeout` default 30 s = one absolute deadline over lock wait + launch + script + teardown. Inside the script: action default 5 s, navigation default 15 s, each clamped to the remaining budget; the agent overrides per call. No implicit waits after clicks.
- Output: console lines streamed live; return value (if not undefined) printed last (strings raw, objects pretty JSON). stderr: `Name: message`, <=5 stack frames mapped to script lines, then `[page NAME] URL "Title"` for each page the script touched. Exit 0 ok, 1 error, 124 deadline, 2 usage.
- `--json`: NDJSON frames `{stdout|stderr|image|result|error|done}`; same frames as the daemon socket protocol *(assumed)*, so MCP/bb can reuse them.
- Page console: during a script collect `console.error/warn` and uncaught page exceptions from touched pages; print <=20 lines on stderr at the end as `[page:NAME] ...`; `--quiet-page` disables.
- Output cap: 50k chars; beyond that keep first 40k + last 5k, spill the full text to `~/.doobie/tmp/out-<id>.txt`, print one marker line with the path and a `sed -n` hint. `--no-cap` disables.

## 5. Script API

Globals: `browser`, `saveFile(name, data) -> path`, `readFile(name) -> string` (tmp jail `~/.doobie/tmp`), `console`, standard JS. No `bash()`, no virtual fs, no sheets, no host fs.

`browser`: `getPage(nameOrTargetId)`, `newPage()`, `listPages() -> [{id,name|null,url,title}]`, `closePage(name)`.

`page` is a Puppeteer `Page` plus:
- `page.goto(url, opts)` default `waitUntil: 'domcontentloaded'`.
- `page.snapshot({ scope?, interactive?, depth?, track?, boxes?, maxChars? }) -> string | { full, incremental }`. Full ARIA YAML (ported in-page script, isolated world), refs on visible elements, frame-prefixed refs `f1e5`, default cap ~20k chars with a truncation marker that names the narrowing options, `track` gives diffs, `boxes` adds `[x,y,w,h]`.
- `page.ref('e5') -> ElementHandle`; custom query handler so `ref/e5` works in every Puppeteer selector API (`page.click('ref/e5')`, `page.type('ref/e12', 'hi')`, `page.$('ref/e5')`, `page.locator('ref/e5')`).
- `page.shot({ name?, fullPage?, clip? }) -> { path, width, height }`: JPEG q80, <=1568 px longest side, CSS-pixel coordinates preserved 1:1 for `page.mouse.*`.
- `page.waitForLoad({ timeout? }) -> { ready, readyState, pending, ms }`: readyState complete AND no new requests for 300 ms (ignore sockets/streams older than 2 s) AND no DOM mutations for 200 ms; cap 3 s; never throws.
- `page.fill(sel, text)`: clear + type.
- Dropped: `domCua`, `cua` object (use `page.mouse` + `shot`), `sleep`, `text/html/press/select` wrappers.

Ref semantics *(assumed)*: refs are stable for the same element within one document; a new document resets; a stale ref throws `ref e5 is stale — take a new snapshot`.

## 6. CLI surface

`doobie [--browser NAME] [--connect [URL]] [--headless] [--timeout S] [--json] [--idle-timeout D] [--quiet-page] [--no-cap] [-e CODE | run FILE | < stdin]`
Subcommands: `pages`, `browsers`, `status`, `stop [NAME]`, `install`, `install-skill [--claude|--codex|--agents]`, `chrome [--profile NAME]`, `daemon` (internal), `--help`, `--version`.
Not in v2: `doctor`, `serve`/MCP, `--arg`.

## 7. Docs

- Tiny SKILL.md (install + "run `doobie --help`") and a full `--help` dump that is the single source of truth (dev-browser style). One markdown source generates both.
- Consumers: Claude Code and Codex first (images via file path + Read). MCP later over the same frame protocol.

## 8. Quality bar

- Parity checklist: `docs/exploration.md` §5 minus the dropped items above.
- Benchmarks in CI (warm daemon, headless): `1+1` <= 25 ms; `getPage + title` <= 40 ms; snapshot 3 KB page <= 30 ms; Google SERP snapshot <= 150 ms; `shot()` <= 120 ms; cold start <= 1.5 s; per-awaited-call overhead <= 0.1 ms over raw Puppeteer.
- Tests with real headless Chrome on macOS + Linux.

## 9. Decisions I own (not asked)

- Socket protocol: NDJSON over unix socket, version handshake in the first frame; mismatch -> client asks old daemon to exit and spawns the new one.
- Spawn lock + bind-first cold start; pid file written after bind; unlink socket only if owner.
- Config file `~/.doobie/config.json` (headless default, idle timeout, chrome path).
- Exact-pinned `puppeteer-core`; checksum on binary download.
- Browser name sanitized as a path segment.
