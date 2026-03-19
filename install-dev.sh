#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Installing daemon dependencies..."
cd "$REPO_DIR/daemon" && pnpm install

echo "==> Bundling daemon..."
cd "$REPO_DIR/daemon" && pnpm run bundle

echo "==> Installing dev-browser binary..."
cargo install --path "$REPO_DIR/cli" --force

echo "==> Installing embedded daemon runtime..."
dev-browser install

echo ""
echo "✅ dev-browser installed!"
echo ""
echo "Usage:"
echo "  dev-browser <<'EOF'"
echo '  const page = await browser.getPage("main");'
echo '  await page.goto("https://example.com");'
echo '  console.log(await page.title());'
echo "  EOF"
