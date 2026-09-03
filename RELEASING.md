# Releasing dev-browser

GitHub Actions publishes the npm package through npm trusted publishing (OIDC); no `NPM_TOKEN` is required. The trusted
publisher must name the `SawyerHood/dev-browser` repository and `.github/workflows/release.yml` workflow.

## Prepare and validate

1. Start from a clean, current `main` branch.
2. Update `package.json`, `.claude-plugin/marketplace.json`, and `CHANGELOG.md` to the intended version.
3. Run:

```bash
bun install --frozen-lockfile
bun x tsc --noEmit
bun run build
bun run test
npm pack --dry-run
dist/dev-browser --version
```

For a release candidate, use a version such as `1.0.0-rc.1`; the workflow publishes prereleases under npm's `next`
tag. Install and exercise that candidate on macOS Intel/ARM and glibc Linux x64/ARM, including clean installs, upgrades
from 0.2.9, an existing `~/.dev-browser` directory, and `migrate-from-doobie`.

## Resolve the historical v1.0.0 tag

The repository has an old `v1.0.0` tag on commit `b549fb0` with no GitHub release or npm version. Before publishing the
real 1.0.0, preserve that reference under a non-release tag and remove the stale release tag:

```bash
git tag archive/browser-skill-v1.0.0 b549fb0
git push origin archive/browser-skill-v1.0.0
git push origin :refs/tags/v1.0.0
git tag -d v1.0.0
```

Deleting the public tag is intentionally a manual maintainer action. Confirm the archive tag exists remotely first.

## Publish

After the release commit is merged and `main` CI is green:

```bash
git switch main
git pull --ff-only origin main
git tag v1.0.0
git push origin v1.0.0
```

The workflow verifies the tag matches `package.json`, builds and checksums four binaries, smoke-tests Linux x64, checks
the npm tarball, creates the GitHub release, and publishes npm with provenance. Verify afterward:

```bash
gh run list --workflow release.yml --limit 1
npm view dev-browser version dist-tags
npm install -g dev-browser@1.0.0
dev-browser --version
dev-browser --help
```

Do not reuse a version if npm accepted it before a later release step failed.
