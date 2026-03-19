# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
