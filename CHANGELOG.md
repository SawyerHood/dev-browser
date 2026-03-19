# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-03-19

### Added

- Initial CLI launch built around a Rust front end for near-instant startup and a background Node.js daemon that runs scripts in a QuickJS WASM sandbox.
- Full Playwright API access from sandboxed scripts, including persistent named pages that survive across runs.
- `--connect` mode for attaching to an existing Chrome instance, with auto-discovery support when no endpoint is provided.
- `--headless` mode for daemon-managed Chromium runs without a visible browser window.
- Sandboxed file I/O helpers for screenshots and temporary artifacts via `saveScreenshot`, `writeFile`, and `readFile`.
- Cross-platform native binaries for macOS (`arm64`, `x64`) and Linux (`x64`, `arm64`, and musl targets).
- npm distribution with a `postinstall` step that downloads the appropriate native binary for the host platform.
