# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- On Windows, daemon spawn now breaks out of the parent Job Object (`CREATE_BREAKAWAY_FROM_JOB`, with a WMI `Win32_Process.Create` fallback when breakaway is denied) so the daemon survives agent-harness command teardown.

## [0.2.9] - 2026-07-14

- Added configurable per-browser idle cleanup with `--idle-timeout`, `DEV_BROWSER_IDLE_TIMEOUT_MS`, and `~/.dev-browser/config.json` support. Idle cleanup preserves persistent profiles, excludes externally connected Chrome, and safely rechecks activity under the per-browser lock before closing.

## [0.2.8] - 2026-06-05

- Added the `page.cua.*` pixel/vision toolset: coordinate-based `click`, `doubleClick`, `drag`, `move`, `scroll`, `keypress`, and `type`, plus a JPEG `screenshot()` whose pixels map 1:1 onto click coordinates at any DPR.
- Added the `page.domCua.*` DOM-id toolset: `getVisibleDom()` snapshots visible interactive elements as `node_id=N` lines, with `click`, `doubleClick`, `scroll`, `type`, and `keypress` acting against the latest snapshot's ids.
- Fixed script error messages being dropped from CLI output; thrown errors now report their name and message alongside the stack.
- Documented the vision and DOM-id workflows in the `--help` LLM usage guide.
- Capped the daemon's per-connection request buffer so a local client can no longer exhaust daemon memory with an unterminated frame.
- Serialized `browser-stop` with the per-browser lock so a browser can no longer be torn down while another client's script is running.
- Hardened daemon cold start against duplicate daemons when concurrent CLI invocations race to spawn one.
- Defaulted `PW_CHROMIUM_ATTACH_TO_OTHER=1` so attaching over CDP to Chrome 147's built-in remote debugging no longer hangs.

## [0.2.7] - 2026-04-09

- Updated documentation to recommend `domcontentloaded` for dev server navigation.

## [0.2.6] - 2026-03-30

- Pinned Playwright version.

## [0.2.5] - 2026-03-30

- Updated Windows documentation with PowerShell examples.
- Use null viewport for headed mode.

## [0.2.4] - 2026-03-26

- Added `--ignore-https-errors` flag for self-signed certificates.

## [0.2.3] - 2026-03-25

- Added Windows x64 compatibility.

## [0.2.1] - 2026-03-19

- Added an interactive `install-skill` TUI command to install the skill into `~/.claude/skills/` and `~/.agents/skills/`.
- Added a `--timeout` flag for script execution with a 30-second default.
- Documented `page.snapshotForAI()` for LLM-friendly page inspection.
- Expanded the `--help` LLM usage guide with approach guidance, screenshots, waiting patterns, and error recovery.
- Simplified the README, added a Windows-not-supported note, and attributed Do Browser.
- Aligned marketplace versioning with `package.json` and added auto-sync support.
- Added `rustfmt` and Prettier plus CI format checks.

## [0.2.0] - 2026-03-19

Initial CLI release.
