# Contributing to dev-browser

Install Bun 1.3 or newer, then install dependencies and run the checks:

```bash
bun install --frozen-lockfile
bun x tsc --noEmit
bun run build
bun run test
```

Runtime state defaults to `~/.dev-browser/v1`. Tests and local experiments should set `DEV_BROWSER_HOME` to an isolated
temporary directory. Update `docs/help.md`, `README.md`, and `skills/dev-browser/SKILL.md` whenever user-facing behavior
changes.
