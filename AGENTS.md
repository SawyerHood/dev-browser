# Repository guide

This repository ships `dev-browser`, a Bun-compiled browser automation CLI and warm daemon built on Puppeteer.

## Tooling

- Use Bun for dependency installation, builds, tests, and TypeScript tooling. Do not use pnpm.
- The npm package contains a small Node-compatible shim and download scripts; test those under Node as well as Bun.
- `docs/help.md` is embedded into the binary and is the source of truth for `dev-browser --help`.

## Validation

Run before finishing runtime changes:

```bash
bun install --frozen-lockfile
bun x tsc --noEmit
bun run build
bun run test
```

For packaging or release changes, also run:

```bash
npm pack --dry-run
dist/dev-browser --version
dist/dev-browser --help | head -n 1
```

Tests that launch Chrome should set `DEV_BROWSER_HOME` to a temporary directory. Never point tests at a user's real
`~/.dev-browser/v1` state.
