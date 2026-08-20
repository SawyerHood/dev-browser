# doobie — handoff (paused 2026-08-20)

## State

- Repo: `/home/sawyer/projects/dev-browser-2` (local git, 3 commits, no remote yet). Target public repo: `SawyerHood/doobie`.
- Build: `export PATH="$HOME/.bun/bin:$PATH"; unset NODE_PATH; bun run build` → `dist/doobie` (single Bun binary, ~92 MB) and `build/daemon.js`.
- Tests: `bun test` → 254 pass / 0 fail (~75 s, real headless Chrome). Typecheck: `bun x tsc --noEmit` clean.
- Bench: `bun run bench/run.ts --check` → all 8 targets pass. Warm `1+1` 13.6 ms, `getPage+title` 13.8 ms, SERP snapshot 18.6 ms in-page, cold start ~590 ms.
- Docs: `docs/help.md` (embedded in `--help`, 300 lines), `skills/doobie/SKILL.md`, `README.md`, `docs/design-decisions.md` (spec, updated with behavior changes), `docs/exploration.md` (reference analysis of dev-browser/do-browser).
- Memory: `~/.claude/projects/-home-sawyer-projects-dev-browser-2/memory/` has the goal and decisions.

## What was done this session

1. Explored dev-browser (Rust CLI + QuickJS/Playwright) and do-browser (extension + Puppeteer) with 12 agents → `docs/exploration.md`.
2. Grilling session (39 questions) → `docs/design-decisions.md`. Name chosen: **doobie**.
3. Built from scratch: Bun-native thin client (`src/cli`), daemon (`src/daemon`: socket server, BrowserManager with launch/cdp/socket sources, PageRegistry with file-backed names, vm-based script runner with deadline + RunGate), page helpers (`src/page`: snapshot engine with refs + `ref/` query handler, shot, waitForLoad, fill, extend), CLI commands, npm packaging (`bin/doobie.cjs`, `scripts/postinstall.cjs`), GitHub workflows (ci, release), benchmarks (`bench/`), tests (`test/`).
4. Adversarial review (9 finders + 160 verifiers) → 82 confirmed findings → fixed in 3 tracks + docs refresh. All fixed items are listed in the workflow reports (`/tmp/claude-1000/.../tasks/woaaqxmbr.output`) and reflected in `docs/design-decisions.md`.

## Not done / next steps (in priority order)

1. **Second review round**: re-run the adversarial review on the fixed code (expect fewer findings). Especially re-check: background-tab `bringToFront` under load, RunGate behaviour with `page.browser()` pages, the session-restore settle delay in `closeRestoredTabs()` (cold start rose 365 → 590 ms; consider a shorter settle or skip when `Default/` has no `Current Session`), and cache the `--no-sandbox` retry result (saves ~100 ms per cold launch on Linux).
2. **Snapshot token economy**: drop `[cursor=pointer]` on inherently interactive roles (link/button; ~23% of HN chars), consider dropping `row` from name-from-content roles (bigger output), consider `interactive:true` default `urls:false`.
3. **macOS validation**: nothing here ran on macOS. Run the suite + bench on a Mac (chrome.ts system paths, CfT layout, FFI isatty libSystem, Bun.spawn detached, headed window args).
4. **Release**: create the GitHub repo, push, tag `v0.1.0`, verify `release.yml` cross-compiles (linux-x64/arm64, darwin-arm64/x64) and `npm publish`; `scripts/postinstall.cjs` expects `SHA256SUMS` in the release.
5. **Real-Chrome path**: `doobie chrome` + `--connect auto` tested on Linux only with Playwright's Chromium; test with a real Google Chrome and Google sign-in.
6. **bb in-app browser hook**: socket source exists (`--connect unix:/path`, raw CDP JSON lines; test in `test/socket-source.test.ts`). bb side: expose `webContents.debugger` over a Unix socket (see `plans/bb-browser.md` in the bb repo).
7. **MCP server** over the same NDJSON frames (`--json` contract) — not started.
8. **Windows** — deliberately after 1.0.
9. Small items from review notes: `instanceof Error/Array/Promise` are false for Puppeteer-returned values (realm split; doc or inject host constructors), saveFile non-string arg message, shot file perms 0644 vs 0600, dynamic `import()` opaque error, unhandled promise rejections in scripts not surfaced.

## How to resume

```bash
cd /home/sawyer/projects/dev-browser-2
export PATH="$HOME/.bun/bin:$PATH"; unset NODE_PATH
bun install && bun x tsc --noEmit && bun test && bun run build && bun run bench/run.ts --check
DOOBIE_HOME=/tmp/d1 dist/doobie --headless -e 'const p = await browser.getPage("x"); await p.goto("https://example.com"); await p.snapshot()'
```
