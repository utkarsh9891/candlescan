#!/usr/bin/env bash
# Build and copy into ../utkarsh9891.github.io/candlescan/ (or pass a path). See README.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_PAGES="$REPO_ROOT/../utkarsh9891.github.io"

usage() {
  echo "Usage: $0 [path-to-utkarsh9891.github.io]"
  echo "Omit the path if ../utkarsh9891.github.io exists."
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

PAGES_REPO="${1:-}"
if [[ -z "$PAGES_REPO" ]]; then
  if [[ -f "$DEFAULT_PAGES/index.html" ]]; then
    PAGES_REPO="$DEFAULT_PAGES"
    echo "Using: $PAGES_REPO"
  else
    echo "Pass the path to utkarsh9891.github.io"
    usage
    exit 1
  fi
fi

if [[ ! -f "$PAGES_REPO/index.html" ]]; then
  echo "Not a valid site folder (no index.html): $PAGES_REPO"
  exit 1
fi

TARGET="${PAGES_REPO}/candlescan"
cd "$REPO_ROOT"

if ! command -v npm >/dev/null 2>&1; then
  echo "Install Node.js: https://nodejs.org"
  exit 1
fi

npm install
npm run build

rm -rf "${TARGET:?}"
mkdir -p "$TARGET"
cp -R "${REPO_ROOT}/dist/." "${TARGET}/"

echo ""
echo "Next, publish from the site repo:"
echo "  cd \"$PAGES_REPO\""
echo "  git add candlescan && git commit -m \"Deploy CandleScan\" && git push"
echo ""
