#!/usr/bin/env bash
# Build the static demo and publish dist/ to the gh-pages branch.
#   bash scripts/deploy-pages.sh
# Requires: a populated data/app.db (run the ingest pipeline first) and push access.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

REMOTE_URL="$(git config --get remote.origin.url)"
echo "→ Building static demo…"
npm run build:static

# SPA fallback for client-side routes + disable Jekyll processing.
cp dist/index.html dist/404.html
touch dist/.nojekyll

echo "→ Publishing dist/ to gh-pages…"
COMMIT="$(git rev-parse --short HEAD)"
cd dist
git init -q
git checkout -q -b gh-pages
git add -A
git -c user.name="deploy" -c user.email="deploy@local" commit -qm "Deploy demo from $COMMIT"
git push -f "$REMOTE_URL" gh-pages
cd ..
rm -rf dist/.git
echo "✅ Pushed to gh-pages. Enable Pages (branch: gh-pages) if not already."
