# Releasing dev-browser

## First Time Setup

### 1. npm authentication
```bash
npm login
```

### 2. GitHub secrets
Go to **GitHub repo → Settings → Secrets and variables → Actions** and add:
- `NPM_TOKEN` — your npm access token (create at https://www.npmjs.com/settings/tokens)

## Publishing a New Version

### 1. Bump the version
```bash
node scripts/sync-version.js 0.2.0
```
This updates both `package.json` and `cli/Cargo.toml`.

### 2. Commit
```bash
git add -A && git commit -m "release: v0.2.0"
```

### 3. Tag and push
```bash
git tag v0.2.0
git push && git push --tags
```

The GitHub Actions release workflow triggers automatically and:
1. Cross-compiles the Rust CLI for 6 platforms (macOS ARM64/x64, Linux x64/ARM64/musl, Windows x64)
2. Bundles the daemon and sandbox client
3. Creates a GitHub release with all binaries attached
4. Publishes to npm

### 4. Verify
```bash
npm info dev-browser version    # should show 0.2.0
npm install -g dev-browser      # test the install
dev-browser --help              # verify it works
```

## Quick Patch Release

Same flow, just use a patch version:
```bash
node scripts/sync-version.js 0.1.1
git add -A && git commit -m "release: v0.1.1"
git tag v0.1.1
git push && git push --tags
```

## What the CI Does

See `.github/workflows/release.yml`. On tag push (`v*`):

| Step | What happens |
|------|-------------|
| **Build** | Cross-compiles Rust CLI for each platform target |
| **Bundle** | Runs `pnpm run bundle` and `pnpm run bundle:sandbox-client` in `daemon/` |
| **Assemble** | Copies bin wrapper, postinstall, daemon bundles, README, LICENSE into publish dir |
| **Publish npm** | `npm publish` from the assembled directory |
| **GitHub Release** | Creates a release with platform binaries attached |

## Platform Binaries

| Platform | Rust Target | Binary Name |
|----------|------------|-------------|
| macOS Apple Silicon | `aarch64-apple-darwin` | `dev-browser-darwin-arm64` |
| macOS Intel | `x86_64-apple-darwin` | `dev-browser-darwin-x64` |
| Linux x64 | `x86_64-unknown-linux-gnu` | `dev-browser-linux-x64` |
| Linux ARM64 | `aarch64-unknown-linux-gnu` | `dev-browser-linux-arm64` |
| Linux x64 (musl) | `x86_64-unknown-linux-musl` | `dev-browser-linux-musl-x64` |
| Windows x64 | `x86_64-pc-windows-msvc` | `dev-browser-windows-x64.exe` |

## How Users Install

```bash
# Global install (postinstall downloads binary, patches shims for zero Node startup)
npm install -g dev-browser
dev-browser install    # installs Playwright + Chromium

# Or one-off via npx (uses Node wrapper, slightly slower startup)
npx dev-browser --help
```

Windows PowerShell:

```powershell
npm install -g dev-browser
dev-browser install
chrome.exe --remote-debugging-port=9222
dev-browser --connect
```
