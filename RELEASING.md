# Releasing dev-browser

## First-Time Setup

npm publishing uses GitHub Actions trusted publishing (OIDC), so the release
workflow does not need an `NPM_TOKEN`. In the npm package settings for
`dev-browser`, configure a trusted publisher with:

- Organization or user: `SawyerHood`
- Repository: `dev-browser`
- Workflow filename: `release.yml`

The workflow needs `id-token: write`, which is already configured in
`.github/workflows/release.yml`.

## Publishing a New Version

### 1. Prepare the release

Start from an up-to-date `main` branch with a clean working tree. Move the
relevant entries from `Unreleased` into a dated version section in
`CHANGELOG.md`, then bump the version:

```bash
npm version 0.2.9 --no-git-tag-version
```

The npm lifecycle hook updates all version-bearing files:

- `package.json`
- `package-lock.json`
- `cli/Cargo.toml`
- `cli/Cargo.lock`
- `.claude-plugin/marketplace.json`

Confirm that they all contain the intended version before tagging.

### 2. Build and validate

The Rust binary embeds the generated daemon bundles, so regenerate both bundles
before building the CLI:

```bash
cd daemon
pnpm install
pnpm bundle
pnpm bundle:sandbox-client
npx tsc --noEmit
pnpm vitest run
cd ../cli
cargo build
cd ..
```

Also confirm that the normal CI checks for `main` are green before publishing.

### 3. Commit

```bash
git add -A
git commit -m "release: v0.2.9"
```

### 4. Merge, tag, and push

Merge the release commit to `main`, update the local branch, and create the tag
on the resulting `main` commit. The tag must exactly match the version in
`package.json`:

```bash
git switch main
git pull --ff-only origin main
git tag v0.2.9
git push origin v0.2.9
```

Pushing any `v*` tag triggers the GitHub Actions release workflow. Do not push
the tag until the release commit is merged and CI is green: the workflow does
not independently verify that the tag and package versions match.

### 5. Monitor and verify

Wait for the `Release` workflow to finish, then verify both distribution
channels:

```bash
gh run list --workflow release.yml --limit 1
npm info dev-browser version
npm install -g dev-browser
dev-browser --help
```

If publishing fails after npm accepts the version, do not reuse that version;
fix the release workflow and publish a new patch version.

## What the CI Does

See `.github/workflows/release.yml`. On tag push (`v*`):

| Step | What happens |
|------|-------------|
| **Bundle** | Runs `pnpm bundle` and `pnpm bundle:sandbox-client` in `daemon/` |
| **Build** | Cross-compiles the Rust CLI for each platform target, embedding the generated daemon bundles |
| **Assemble** | Copies bin wrapper, postinstall, daemon bundles, README, LICENSE into publish dir |
| **Publish npm** | Uses OIDC trusted publishing to run `npm publish` from the assembled directory |
| **GitHub Release** | Creates a release with generated notes and the platform binaries attached |

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
