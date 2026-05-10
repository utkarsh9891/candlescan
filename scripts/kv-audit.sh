#!/usr/bin/env bash
#
# KV audit — list every key in CANDLESCAN_KV and classify each as
# active (referenced by current worker code), stale (orphaned), or
# unknown. Optionally cleans up stale keys with --clean.
#
# Usage:
#   bash scripts/kv-audit.sh                 # list + classify, no writes
#   bash scripts/kv-audit.sh --clean         # additionally delete stale keys
#
# Active classifications come from the current worker/index.js — if you
# add a new KV key in the worker, add its prefix to ACTIVE_PREFIXES below.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Prefixes / exact names referenced by current worker/index.js.
# (Verify with:  grep -E "CANDLESCAN_KV\.(get|put|delete)" worker/index.js)
ACTIVE_EXACT=(
  "GATE_PUBLIC_KEY"
  "kite_nse_instruments"
  "dhan_nse_instruments"
)
ACTIVE_PREFIXES=(
  "nse_fiidii_daily:"
  "nse_vix_daily:"
)

# Known stale (left behind by removed endpoints).
STALE_EXACT=(
  "TEST_KEY"
)
STALE_PREFIXES=(
  "yahoo_news:"   # /news/yahoo endpoint dropped — see commit history
)

CLEAN=false
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=true ;;
    -h|--help)
      sed -n '3,15p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

KV_ID=$(grep -A2 'binding = "CANDLESCAN_KV"' worker/wrangler.toml | grep 'id = ' | sed 's/.*id = "\(.*\)"/\1/')
if [[ -z "$KV_ID" ]]; then
  echo "could not find CANDLESCAN_KV id in worker/wrangler.toml" >&2
  exit 1
fi

cd worker
echo "auditing CANDLESCAN_KV (${KV_ID})..."
KEYS_JSON=$(npx wrangler kv key list --namespace-id="$KV_ID" --remote 2>/dev/null)
NAMES=$(echo "$KEYS_JSON" | grep -oE '"name": "[^"]+"' | sed 's/"name": "//;s/"$//')

if [[ -z "$NAMES" ]]; then
  echo "namespace is empty."
  exit 0
fi

declare -a STALE=()
declare -a ACTIVE=()
declare -a UNKNOWN=()

while IFS= read -r name; do
  # Active exact?
  matched=false
  for e in "${ACTIVE_EXACT[@]}"; do
    if [[ "$name" == "$e" ]]; then ACTIVE+=("$name"); matched=true; break; fi
  done
  $matched && continue
  # Active prefix?
  for p in "${ACTIVE_PREFIXES[@]}"; do
    if [[ "$name" == "$p"* ]]; then ACTIVE+=("$name"); matched=true; break; fi
  done
  $matched && continue
  # Stale exact?
  for e in "${STALE_EXACT[@]}"; do
    if [[ "$name" == "$e" ]]; then STALE+=("$name"); matched=true; break; fi
  done
  $matched && continue
  # Stale prefix?
  for p in "${STALE_PREFIXES[@]}"; do
    if [[ "$name" == "$p"* ]]; then STALE+=("$name"); matched=true; break; fi
  done
  $matched && continue
  UNKNOWN+=("$name")
done <<< "$NAMES"

printf "\nactive   (%d)\n" "${#ACTIVE[@]}"
for k in "${ACTIVE[@]}"; do printf "  ✓ %s\n" "$k"; done

printf "\nstale    (%d)\n" "${#STALE[@]}"
for k in "${STALE[@]}"; do printf "  ✗ %s\n" "$k"; done

if [[ ${#UNKNOWN[@]} -gt 0 ]]; then
  printf "\nunknown  (%d) — verify before deleting\n" "${#UNKNOWN[@]}"
  for k in "${UNKNOWN[@]}"; do printf "  ? %s\n" "$k"; done
fi

if [[ "$CLEAN" == true && ${#STALE[@]} -gt 0 ]]; then
  printf "\ndeleting %d stale keys...\n" "${#STALE[@]}"
  for k in "${STALE[@]}"; do
    npx wrangler kv key delete --namespace-id="$KV_ID" --remote "$k" >/dev/null 2>&1 \
      && echo "  deleted: $k" \
      || echo "  failed:  $k"
  done
elif [[ "$CLEAN" == true ]]; then
  echo "nothing to clean."
elif [[ ${#STALE[@]} -gt 0 ]]; then
  printf "\nrun with --clean to delete the %d stale key(s).\n" "${#STALE[@]}"
fi
