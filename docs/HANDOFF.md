# doobie — handoff (updated 2026-08-20, after review round 2)

## State

- Repo: `/home/sawyer/projects/dev-browser-2` -> `git@github.com:SawyerHood/doobie.git` (public), branch `main`. CI (`ci.yml`, ubuntu + macos, real Chrome for Testing pinned via `DOOBIE_CHROME`) is green on `main`; `release.yml` ran for the prerelease tag **`v0.1.0-rc.1`** (GitHub release with four binaries + `SHA256SUMS`; npm publish only when `NPM_TOKEN` is set).
- Build: `export PATH="$HOME/.bun/bin:$PATH"; unset NODE_PATH; bun run build` -> `dist/doobie` (single Bun binary, ~92 MB) and `build/daemon.js`.
- Tests: `bun test` (real headless Chrome, ~2 min; see `package.json` `test` for the timeout). Typecheck: `bun x tsc --noEmit` clean.
- Bench: `bun run bench/run.ts --check` -> all 8 targets pass. Warm `1+1` ~13 ms, `getPage+title` ~14 ms, SERP snapshot ~18 ms in-page, `shot()` ~36 ms, per-call overhead 0.03 ms, cold start ~280 ms (9-run medians, Linux).
- Docs: `docs/help.md` (embedded in `--help`, 320 lines, hard cap 320), `skills/doobie/SKILL.md`, `README.md`, `docs/design-decisions.md` (spec, kept in sync with behaviour changes), `docs/bb-integration.md` (socket source contract for the bb in-app browser), `docs/exploration.md` (reference analysis of dev-browser/do-browser).
- Memory: `~/.claude/projects/-home-sawyer-projects-dev-browser-2/memory/` has the goal and decisions.

## Done

1. Explored dev-browser (Rust CLI + QuickJS/Playwright) and do-browser (extension + Puppeteer) -> `docs/exploration.md`; grilling session -> `docs/design-decisions.md`. Name: **doobie**.
2. Built from scratch: Bun-native thin client (`src/cli`), daemon (`src/daemon`: socket server, BrowserManager with launch/cdp/socket sources, PageRegistry with file-backed names, vm-based script runner with deadline + RunGate), page helpers (`src/page`: snapshot engine with refs + `ref/` query handler, shot, waitForLoad, fill, extend), CLI commands, npm packaging (`bin/doobie.cjs` shim, `scripts/postinstall.cjs`, `scripts/download-binary.cjs`), GitHub workflows (ci, release), benchmarks (`bench/`), tests (`test/`).
3. Adversarial review round 1 (82 confirmed findings) fixed: transport backpressure, profiles per mode, page mutex, zombie runs, shot DPR, dialogs, snapshot names/frames/boxes, docs.
4. **macOS validated**: suite + bench run on a Mac (chrome.ts system paths, CfT layout, FFI isatty, detached spawn, headed args); CI matrix includes `macos-latest`.
5. **GitHub repo + CI + prerelease**: repo pushed, `ci.yml` green on both OSes, `v0.1.0-rc.1` released by `release.yml`; the npm path (`npm install -g <tgz>` -> postinstall download -> `doobie --version`) verified against the release assets.
6. **MCP server**: `doobie mcp [-b NAME] [--headless] [--connect URL] [-t S]` (stdio JSON-RPC, tools `doobie_run/pages/browsers/stop/help`, images as image content) over the same daemon frames; `test/mcp.test.ts`.
7. **bb note**: `docs/bb-integration.md` documents the `--connect unix:/path` raw-CDP contract (`test/socket-source.test.ts`); the bb side (expose `webContents.debugger` over a Unix socket) is not started.
8. Snapshot token economy: no `[cursor=pointer]` on inherently interactive roles, no `row` content names (HN interactive 29k -> 21k chars); launch marks clean exits to skip session restore and caches the `--no-sandbox` retry (cold start 590 -> ~280 ms).
9. **Review round 2** (this session) fixed: per-browser bring-to-front lock (no cached front tab; raf waits on background tabs work; two scripts on two tabs of one headless Chrome no longer hang); RunGate covers ElementHandle/JSHandle/Frame/`browser().pages()`/popups (identity-stable proxies); `setRequestInterception`, `setDefaultTimeout`/`setDefaultNavigationTimeout` reset per script; `beforeunload` accepted; `BrowserStoppedError` on `doobie stop` mid-script; `(goto "URL" failed)` page line; cross-realm errors logged; `--connect` extends only touched tabs/popups; `doobie chrome` verifies the launch (`/json/version` within 3 s, stderr tail + `~/.doobie/chrome-logs/NAME.log`, `--no-sandbox` retry, `--headless`); `help <unknown>` exits 2; `pages`/`status` no longer reset the idle clock; snapshot: pointer inheritance only from rendered pointer-receiving ancestors, `::before/::after` + svg `<title>` names, iframe padding in `[box]`, ref counter survives in-page upgrades (INPAGE_VERSION 4), Playwright name fallbacks (placeholder, "Choose File", legend/caption/figcaption), `ref/eN` across shadow roots; packaging: self-healing shim when install scripts are blocked, runtime deps -> devDependencies (tarball = shim + 2 scripts), `relinkGlobal` only for global installs of this package, `DOOBIE_DOWNLOAD_BASE` / `DOOBIE_SKIP_DOWNLOAD`, release tag must equal `v<package.json version>` (+ smoke test, tarball check, prerelease marking, `npm publish --tag next`), CI pins `DOOBIE_CHROME`; docs refreshed (help.md, README perf table re-measured, SKILL.md, design-decisions.md).

## Not done / next steps (in priority order)

1. **Final release**: bump `package.json` to `0.1.0`, commit, push tag `v0.1.0` (release.yml enforces the match; postinstall/shim honour `DOOBIE_DOWNLOAD_BASE` for mirrors/tests), set `NPM_TOKEN` for the npm publish, install from npm on a clean machine (`npm i -g doobie`, `bun add -g doobie` self-heal path).
2. **Real-Chrome path**: `doobie chrome` + `--connect auto` tested on Linux with Playwright's Chromium / CfT only; test with a real Google Chrome and Google sign-in (macOS too).
3. **bb in-app browser**: implement the bb side of `docs/bb-integration.md`.
4. **Known, documented limits** (candidates for code fixes): ref on an element moved to another frame acts on wrong coordinates; sync CPU loops are not preempted by the deadline (watchdog restart); a long single action (type with delay) holds the front lock for other tabs.
5. **Cleanup requested by the round-2 reports**: export `rememberNoSandbox`/`isSandboxError` from `src/daemon/sources/launch.ts` and drop the local copies in `src/cli/commands/chrome.ts` (TODO comment marks the spot).
6. **Windows** — deliberately after 1.0.
7. Small items from review notes: `instanceof Array/Promise` are false for Puppeteer-returned values (realm split; Error family is shared now), saveFile non-string arg message, shot file perms 0644 vs 0600, dynamic `import()` opaque error, unhandled promise rejections in scripts not surfaced.

## How to resume

```bash
cd /home/sawyer/projects/dev-browser-2
export PATH="$HOME/.bun/bin:$PATH"; unset NODE_PATH
bun install && bun x tsc --noEmit && bun test && bun run build && bun run bench/run.ts --check
DOOBIE_HOME=/tmp/d1 dist/doobie --headless -e 'const p = await browser.getPage("x"); await p.goto("https://example.com"); await p.snapshot()'
```
