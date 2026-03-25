#!/bin/sh
# One command to run CandleScan locally. See README.md.
set -e
cd "$(dirname "$0")/.."
if [ ! -x node_modules/.bin/vite ]; then
  echo "First run this once in this folder:"
  echo "  npm install"
  exit 1
fi
echo ""
echo "  ============================================"
echo "  OPEN IN YOUR BROWSER:"
echo "  http://127.0.0.1:5173/candlescan/"
echo "  ============================================"
echo "  Optional (dev only): fake data for UI work"
echo "  http://127.0.0.1:5173/candlescan/?simulate=1"
echo "  ============================================"
echo ""
exec ./node_modules/.bin/vite
