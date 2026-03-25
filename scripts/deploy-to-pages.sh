#!/usr/bin/env bash
set -euo pipefail

PAGES_REPO="${1:?Usage: $0 /absolute/path/to/utkarsh9891.github.io [commit-message]}"
COMMIT_MSG="${2:-Deploy CandleScan $(date +%Y-%m-%d_%H:%M)}"
TARGET="${PAGES_REPO}/candlescan"

echo "==> Installing dependencies..."
npm ci --silent

echo "==> Building..."
npm run build --silent

echo "==> Copying dist/ → ${TARGET}/"
rm -rf "${TARGET:?}"/*
cp -R dist/. "${TARGET}/"

echo "==> Done. Files staged at ${TARGET}"
echo ""
echo "To publish, run:"
echo "  cd \"${PAGES_REPO}\""
echo "  git add candlescan"
echo "  git commit -m \"${COMMIT_MSG}\""
echo "  git push"
