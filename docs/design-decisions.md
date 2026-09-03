# dev-browser — design decisions (grilling session, 2026-08-19)

Source material: `docs/exploration.md` (merged read of dev-browser v0.2.9 and do-browser).
Every item below is a decision the user made. Items marked *(assumed)* are defaults I chose; say so if you want them changed.

## 1. Identity

- Name: **dev-browser**. CLI `dev-browser`, npm package `dev-browser`, state dir `~/.dev-browser/v1/`, skill name `dev-browser`.
- New product, new public repo `SawyerHood/dev-browser`, MIT, single Bun workspace package. `ref/` is git-ignored.
- Platforms: macOS + Linux first. Windows after 1.0. Endpoint abstraction stays pipe-capable.

## 2. Runtime and process model

- Script runtime library: **Puppeteer** (`puppeteer-core`, exact-pinned).
- **Warm daemon + thin client.** Client connects to `~/.dev-browser/v1/daemon.sock`, sends one request, streams frames, exits.
- **Single Bun binary** (`bun build --compile`) is both client and daemon (`dev-browser daemon` is the internal entry). A spike verifies Chrome launch + connect + screenshot under Bun first; fallback is a Node daemon with the same client.
- Sandbox: **`node:vm` context inside the daemon**, real Puppeteer objects passed in. Goal is clean globals only; **no security claim**. Watchdog: the client treats a dead heartbeat as a hung daemon and kills/restarts it.
- Concurrency: **scripts run concurrently**; only browser launch/connect, page creation and front-requiring actions are mutexed. Two scripts on one named page may interleave (documented: "never run them in parallel").
- Front lock: every input/screenshot/wait on a page first calls `bringToFront()` under a per-Browser async lock (no cached "front" tab; headless Chrome silently ignores input and never fires raf/IntersectionObserver on a background tab). Same-page nested actions join the holder; other tabs queue FIFO. Long waits (`waitForSelector`/`waitForFunction`) do not hold the lock; the waiting tab is brought back to front when the lock goes idle. A long single action (type with delay) delays other tabs for its duration.
- The deadline fires between awaits only: synchronous CPU-bound script code cannot be interrupted; an infinite loop is ended by the client watchdog (daemon + launched Chrome restarted, named pages lost).
- Per-script page state is reset at run start/end: `setDefaultTimeout`/`setDefaultNavigationTimeout` back to 5 s / 15 s for every touched page, `setRequestInterception(true)` turned off when the run's gate closes. `browser().pages()/newPage()`, `mainFrame()`, popups and listener payloads are returned as gated, identity-stable proxies (ElementHandle/JSHandle/Frame calls from a zombie run reject too).
- Browser sources: one `BrowserSource` interface with `launch` (named profile), `cdp` (`--connect auto|http://|ws://`), `socket` (`--connect unix:/path`, raw CDP JSON lines; the hook for the bb in-app browser via `webContents.debugger` later). All three ship in v2.

## 3. Browser and lifetimes

- Headed by default, `--headless` flag, config override. Headed: `viewport: null`; headless: 1280x720. A different mode gets its own instance *and its own profile dir* (`browsers/NAME/profile` vs `profile-headless`; `--ignore-https-errors` adds `-insecure`), so two Chromes never share a user-data-dir; no relaunch-on-flag-change. Page names are scoped to the browser key (`NAME`, `NAME:headless`, `NAME:insecure`, `cdp:...`).
- Before every launch dev-browser writes automation prefs into the profile: clean exit (no session restore), password-leak detection OFF (its tab-modal dialog after a login with a leaked/demo credential silently eats all CDP input in new headless Chrome), no save-password bubble, no autofill popups.
- Launch never kills a Chrome it does not own: a profile held by a live foreign Chrome is a `ProfileBusyError`; only orphans of a dead daemon are reclaimed. Tabs Chrome restores from the previous session are closed at launch (one about:blank kept). Launched browsers download into `~/.dev-browser/v1/tmp/downloads/`.
- Input/screenshot on a background tab brings it to the front first (headless Chrome otherwise hangs); pages created through Puppeteer itself (`browser.newPage()`, popups) are extended like named pages. With `--connect` (cdp/socket sources) only tabs dev-browser touched — `getPage(name|targetId)`, `newPage()`, and popups opened from those — are extended; the user's other tabs keep their own dialogs/scripts (`listPages()` never attaches). Launched browsers extend every new target eagerly.
- Downloads: launched browsers write to `~/.dev-browser/v1/tmp/downloads/<name>` (not reachable from `readFile`, which rejects path separators; agents use the shell); attached browsers keep Chrome's own download dir. `goto()` of an attachment URL throws `net::ERR_ABORTED` while the file still lands.
- `dev-browser stop KEY` while a script runs on that browser -> `BrowserStoppedError: browser "KEY" was stopped while the script was running` (kind daemon) instead of a raw Puppeteer "Target closed".
- Only run requests refresh a browser's idle clock; `pages`/`status` do not (a fresh connect from `pages` still uses the default 30 min).
- Chrome acquisition: detect installed Chrome/Chromium/Edge first; `dev-browser install` downloads Chrome for Testing via `@puppeteer/browsers` as fallback (yauzl bundled, so no `unzip` dependency; partial installs are removed on failure); `--chrome <path>` / env override *(assumed: `DEV_BROWSER_CHROME`)*.
- `dev-browser chrome [--profile NAME] [--headless]` launches the user's real Chrome with `--remote-debugging-port` on a dedicated profile (`~/.dev-browser/v1/chrome-profiles/NAME`, never a `-b` profile dir) and remembers the port so `--connect auto` finds it (Google sign-in path). It prefers a system Chrome over `dev-browser install`'s Chrome for Testing and warns when only CfT/Playwright Chromium exists. The launch is verified: Chrome must answer `/json/version` within 3 s; if it exits, the stderr tail and log path (`~/.dev-browser/v1/chrome-logs/NAME.log`) are printed, exit 1, port not recorded; on Linux a sandbox failure is retried once with `--no-sandbox` (remembered in `launch-state.json`); `--headless` passes `--headless=new`.
- Browser idle timeout **default 30 min** (launched browsers only; profile persists). Flag > env > config > default.
- Daemon exits after 15 min with no browsers. `dev-browser stop [NAME]` stops one browser or everything. Daemon auto-starts on the next call.
- Daemon log at `~/.dev-browser/v1/daemon.log`; `status` shows its tail.
- Anonymous pages are **not** auto-closed. `listPages()` shows them with targetIds.
- Page names: **file map per browser `{name -> targetId}`** under `~/.dev-browser/v1/`, validated on use; `getPage('<targetId>')` attaches any tab.

## 4. Request contract

- Input: `dev-browser [flags] < script.js`, `dev-browser run FILE`, `dev-browser -e 'code'`. No `--arg`. TTY with no script prints help.
- Eval: parse with acorn; if the last top-level statement is an expression, it becomes the return value; explicit `return` works; top-level `await` works; **never executes twice**.
- Timeouts: `--timeout` default 30 s = one absolute deadline over lock wait + launch + script + teardown. Inside the script: action default 5 s, navigation default 15 s, each clamped to the remaining budget; the agent overrides per call. No implicit waits after clicks. The deadline message names the in-flight call (`... (deadline) while in page.waitForSelector("#x")`). After the deadline (or client disconnect) the script is a zombie: page proxies reject further calls, its listeners and timers are cleared, and a catch-and-retry loop is abandoned after 50 rejected calls.
- Output: console lines streamed live; return value (if not undefined) printed last (strings raw, objects pretty JSON; Map -> object, Set -> array, Error -> `Name: message`, detected across vm realms). A trailing `{ ... }` that parses as a block is retried as an object literal and returned. stderr: `Name: message`, <=5 stack frames mapped to script lines, then `[page NAME] URL "Title"` for each page the script touched (after a failed `goto` the line is `[page NAME] OLD-URL (goto "URL" failed)`; the tab sits on Chrome's error page). Exit 0 ok, 1 error, 124 deadline, 2 usage (also `help <unknown topic>`, message on stderr). Cross-realm script errors are logged with name/message/stack in `daemon.log`.
- `--json`: NDJSON frames `{stdout|stderr|image|result|error|done}`; same frames as the daemon socket protocol *(assumed)*, so MCP/bb can reuse them. The result frame carries `data` (structured value) next to the formatted `value`.
- Page console: during a script collect `console.error/warn`, uncaught page exceptions and auto-dismissed dialogs from touched pages; print <=20 lines on stderr at the end as `[page:NAME] ...` (favicon 404 noise dropped); `--quiet-page` disables. Unhandled dialogs are dismissed automatically unless the script registered its own `dialog` listener; `beforeunload` is *accepted* (`(auto-accepted)`) so the navigation the script asked for proceeds. Errors carry ` (cause: ...)`.
- Output cap: 50k chars; beyond that keep first 40k + last 5k, spill the full text to `~/.dev-browser/v1/tmp/out-<id>.txt`, print one marker line with the path and a `sed -n` hint. `--no-cap` disables.

## 5. Script API

Globals: `browser`, `saveFile(name, data) -> path`, `readFile(name) -> string` (tmp jail `~/.dev-browser/v1/tmp`), `console`, standard JS. No `bash()`, no virtual fs, no sheets, no host fs.

`browser`: `getPage(nameOrTargetId)`, `newPage()`, `listPages() -> [{id,name|null,url,title}]`, `closePage(name)`.

`page` is a Puppeteer `Page` plus:
- `page.goto(url, opts)` default `waitUntil: 'domcontentloaded'`.
- `page.snapshot({ scope?, interactive?, depth?, track?, boxes?, urls?, maxChars?, frames? }) -> string | { full, incremental }`. Full ARIA YAML (ported in-page script, isolated world), refs on every visible pointer-receiving element (headings included; `interactive` prunes), frame-prefixed refs `f1e5` with frame keys stable for the page's life, default cap ~20k chars with a truncation marker that names the narrowing options, `track` gives line diffs with one context line per hunk (first call = full; a >60 % change falls back to the full snapshot), `boxes` adds `[x,y,w,h]` in main-viewport px, `urls: false` drops `/url` lines.
- `page.ref('e5') -> ElementHandle`; custom query handler so `ref/e5` works in every Puppeteer selector API (`page.click('ref/e5')`, `page.type('ref/e12', 'hi')`, `page.$('ref/e5')`, `page.locator('ref/e5')`).
- `page.shot({ name?, fullPage?, clip?, quality?, maxEdge?, type? }) -> { path, width, height, scale }`: JPEG q80, <=1568 px longest side, CSS-pixel coordinates preserved 1:1 for `page.mouse.*` at any DPR (`scale` < 1 only when downscaled).
- `page.waitForLoad({ timeout? }) -> { ready, readyState, pending, ms }`: readyState complete AND no new requests for 300 ms (ignore sockets/streams older than 2 s) AND no DOM mutations for 200 ms; cap 3 s; never throws.
- `page.fill(sel, text)`: clear + type for text inputs/textarea/contenteditable; date/time/number/color/range values are set directly; throws for readonly/disabled/checkbox/radio/file/`<select>`. No key chords (`Control+a`): use `keyboard.down/press/up`. Relative paths in file options (`uploadFile`, `screenshot({path})`, `pdf({path})`) are rewritten against the calling client's cwd (`RunRequest.cwd`), so scripts behave like a local tool.
- Snapshot names follow Playwright: placeholder, `::before/::after` content, svg `<title>`, legend/figcaption/caption, aria-owns text; an unlabeled `<input type=file>` is `button "Choose File"`. Ref counters live on the isolated-world window so an in-page script upgrade never reuses ids; `ref/eN` resolves across open shadow roots; `[box]` origins include iframe padding.
- Dropped: `domCua`, `cua` object (use `page.mouse` + `shot`), `sleep`, `text/html/press/select` wrappers.

Ref semantics *(assumed)*: refs are stable for the same element within one document; a new document resets; a stale ref throws `Ref "e5" is stale or unknown. Take a new page.snapshot() and use a fresh ref.` from `page.ref()` and from the acting `ref/` selector methods alike (`(cause: No element found for selector: ref/e5)`); `page.$/$$` return null/[]; `page.locator("ref/eN")` only times out; `waitForSelector("ref/eN")` throws Puppeteer's `TimeoutError` like CSS selectors.

## 6. CLI surface

`dev-browser [--browser NAME] [--connect [URL]] [--headless] [--ignore-https-errors] [--timeout S] [--json] [--idle-timeout D] [--quiet-page] [--no-cap] [-e CODE | run FILE | < stdin]`
Subcommands: `pages`, `browsers`, `status`, `stop [NAME]`, `install`, `install-skill [--claude|--codex|--agents]`, `chrome [--profile NAME] [--port N] [--chrome PATH] [--headless] [--list] [URL]`, `mcp` (stdio MCP server over the same frames: `dev_browser_run/pages/browsers/stop/help`), `daemon` (internal), `--help`, `--version`. `pages` with `-b`/`--connect` launches/attaches that browser and lists only its tabs.
Not in v2: `doctor`, `serve`, `--arg`.

## 7. Docs

- Tiny SKILL.md (install + "run `dev-browser --help`") and a full `--help` dump that is the single source of truth (dev-browser style). One markdown source generates both.
- Consumers: Claude Code and Codex first (images via file path + Read). MCP later over the same frame protocol.

## 8. Quality bar

- Parity checklist: `docs/exploration.md` §5 minus the dropped items above.
- Benchmarks in CI (warm daemon, headless): `1+1` <= 25 ms; `getPage + title` <= 40 ms; snapshot 3 KB page <= 30 ms; Google SERP snapshot <= 150 ms; `shot()` <= 120 ms; cold start <= 1.5 s; per-awaited-call overhead <= 0.1 ms over raw Puppeteer.
- Tests with real headless Chrome on macOS + Linux.

## 9. Decisions I own (not asked)

- Socket protocol: NDJSON over unix socket, version handshake in the first frame; mismatch -> client asks old daemon to exit and spawns the new one.
- Spawn lock + bind-first cold start; pid file written after bind; unlink socket only if owner (by inode, before stopping browsers, so `stop` + immediate next call never races a successor daemon).
- Client socket writes honor backpressure (multi-MB scripts), output writes swallow EPIPE.
- Bundles are minified without identifier mangling so Puppeteer error names (`TimeoutError`) survive in messages, `--json` and `e.name`.
- Config file `~/.dev-browser/v1/config.json` (headless default, idle timeout, chrome path).
- Exact-pinned `puppeteer-core`; checksum on binary download. The npm package ships only the `bin/dev-browser.cjs` shim + `scripts/postinstall.cjs` + `scripts/download-binary.cjs` (Puppeteer & co. are devDependencies; the binary embeds them). Postinstall downloads `dev-browser-<os>-<arch>` + `SHA256SUMS` from the GitHub release for the package version; if the install script was blocked (bun, pnpm, `--ignore-scripts`) the shim self-heals on first run (`dev-browser: downloading binary vX`), `DEV_BROWSER_SKIP_DOWNLOAD=1` disables, `DEV_BROWSER_DOWNLOAD_BASE` points at a mirror/local server. `relinkGlobal` only touches the global `dev-browser` link for global installs of this very package. `release.yml` refuses a tag that is not exactly `v<package.json version>`, smoke-tests the linux-x64 binary, checks the tarball, marks `-` tags as prereleases (`npm publish --tag next`).
- Browser name sanitized as a path segment.
