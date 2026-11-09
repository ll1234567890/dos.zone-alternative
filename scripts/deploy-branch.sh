#!/usr/bin/env bash
# Fallback deploy without GitHub Actions: build _site and force-push it as the
# gh-pages branch. Use with Settings -> Pages -> Source: Deploy from a branch
# (gh-pages, / root).
set -euo pipefail
cd "$(dirname "$0")/.."
remote_url=$(git remote get-url origin)
rev=$(git rev-parse --short HEAD)
npm run build
tmp=$(mktemp -d)
cp -r _site/. "$tmp"
cd "$tmp"
git init -q -b gh-pages
git add -A
git commit -qm "Deploy prebuilt site from $rev"
git push -f "$remote_url" gh-pages
rm -rf "$tmp"
echo "Pushed prebuilt site to gh-pages."
