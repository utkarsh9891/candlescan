#!/usr/bin/env bash
#
# KV audit — list keys across CANDLESCAN_CONFIG, CANDLESCAN_CACHE, and
# the legacy CANDLESCAN_KV (during migration), classify each as active
# / stale / unknown based on what worker/index.js actually uses, and
# optionally clean up stale entries with --clean.
#
# Usage:
#   bash scripts/kv-audit.sh                 # list + classify, no writes
#   bash scripts/kv-audit.sh --clean         # additionally delete stale keys
#
# When you add a new KV key in worker/index.js, register it under the
# CONFIG_* or CACHE_* allowlists below so it isn't flagged as stale.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# ── Allowlists, mirrored from worker/index.js ────────────────────────

# Long-lived config (lives in CANDLESCAN_CONFIG, falls back to CANDLESCAN_KV)
CONFIG_EXACT=(
  "GATE_PUBLIC_KEY"
)

# TTL'd caches (live in CANDLESCAN_CACHE, fall back to CANDLESCAN_KV)
CACHE_EXACT=(
  "kite_nse_instruments"
  "dhan_nse_instruments"
)
CACHE_PREFIXES=(
  "nse_fiidii_daily:"
  "nse_vix_daily:"
  "india_news:"
  "quote_last:"
)

# Known stale (left behind by removed endpoints).
STALE_EXACT=(
  "TEST_KEY"
)
STALE_PREFIXES=(
  "yahoo_news:"   # /news/yahoo endpoint dropped in commit history
)

CLEAN=false
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=true ;;
    -h|--help) sed -n '3,15p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

# ── Discover bindings + ids from wrangler.toml ───────────────────────
# Each binding is independent — present some / all and we'll audit each.

extract_id() {
  local binding="$1"
  awk -v b="$binding" '
    /^\[\[kv_namespaces\]\]/ { in_ns=1; bind=""; id=""; next }
    in_ns && $1 == "binding" { gsub(/[" ]/, "", $3); bind=$3 }
    in_ns && $1 == "id"      { gsub(/[" ]/, "", $3); id=$3 }
    in_ns && /^$/            { if (bind == b) print id; in_ns=0 }
    END                       { if (bind == b) print id }
  ' worker/wrangler.toml
}

CONFIG_ID=$(extract_id "CANDLESCAN_CONFIG")
CACHE_ID=$(extract_id "CANDLESCAN_CACHE")
LEGACY_ID=$(extract_id "CANDLESCAN_KV")

# ── Helpers ──────────────────────────────────────────────────────────

list_keys() {
  local id="$1"
  [[ -z "$id" ]] && return 0
  ( cd worker && npx wrangler kv key list --namespace-id="$id" --remote 2>/dev/null )
}

is_active_in() {
  # $1 = name, $2 = "config" | "cache"
  local name="$1" kind="$2"
  if [[ "$kind" == "config" ]]; then
    for e in "${CONFIG_EXACT[@]}"; do [[ "$name" == "$e" ]] && return 0; done
  else
    for e in "${CACHE_EXACT[@]}"; do [[ "$name" == "$e" ]] && return 0; done
    for p in "${CACHE_PREFIXES[@]}"; do [[ "$name" == "$p"* ]] && return 0; done
  fi
  return 1
}
is_stale() {
  local name="$1"
  for e in "${STALE_EXACT[@]}"; do [[ "$name" == "$e" ]] && return 0; done
  for p in "${STALE_PREFIXES[@]}"; do [[ "$name" == "$p"* ]] && return 0; done
  return 1
}

audit_namespace() {
  local label="$1" id="$2" classification="$3"  # classification = "config"|"cache"|"mixed"
  [[ -z "$id" ]] && { printf "\n%-22s (no binding configured)\n" "$label"; return; }
  printf "\n%-22s id=%s  classification=%s\n" "$label" "$id" "$classification"

  # `|| true` on the assignment so an empty namespace (where grep matches
  # nothing) doesn't abort the script under set -o pipefail.
  local keys
  keys=$(list_keys "$id" | grep -oE '"name": "[^"]+"' | sed 's/"name": "//;s/"$//' || true)
  [[ -z "$keys" ]] && { echo "  (empty)"; return; }

  local -a active=() stale=() unknown=()
  while IFS= read -r name; do
    if is_stale "$name"; then
      stale+=("$name"); continue
    fi
    case "$classification" in
      config) is_active_in "$name" config && active+=("$name") || unknown+=("$name") ;;
      cache)  is_active_in "$name" cache  && active+=("$name") || unknown+=("$name") ;;
      mixed)
        if is_active_in "$name" config || is_active_in "$name" cache; then
          active+=("$name")
        else
          unknown+=("$name")
        fi
        ;;
    esac
  done <<< "$keys"

  printf "  active   (%d)\n" "${#active[@]}"
  if (( ${#active[@]} > 0 )); then
    for k in "${active[@]}"; do printf "    ✓ %s\n" "$k"; done
  fi
  printf "  stale    (%d)\n" "${#stale[@]}"
  if (( ${#stale[@]} > 0 )); then
    for k in "${stale[@]}"; do printf "    ✗ %s\n" "$k"; done
  fi
  if (( ${#unknown[@]} > 0 )); then
    printf "  unknown  (%d) — verify before deleting\n" "${#unknown[@]}"
    for k in "${unknown[@]}"; do printf "    ? %s\n" "$k"; done
  fi
  if [[ "$CLEAN" == true && ${#stale[@]} -gt 0 ]]; then
    printf "  deleting %d stale key(s)...\n" "${#stale[@]}"
    for k in "${stale[@]}"; do
      ( cd worker && npx wrangler kv key delete --namespace-id="$id" --remote "$k" >/dev/null 2>&1 ) \
        && echo "    deleted: $k" \
        || echo "    failed:  $k"
    done
  fi
}

# ── Run ──────────────────────────────────────────────────────────────

echo "auditing CANDLESCAN_* KV namespaces..."
audit_namespace "CANDLESCAN_CONFIG"  "$CONFIG_ID"  "config"
audit_namespace "CANDLESCAN_CACHE"   "$CACHE_ID"   "cache"
audit_namespace "CANDLESCAN_KV (legacy)" "$LEGACY_ID" "mixed"

if [[ "$CLEAN" != true ]]; then
  echo ""
  echo "(read-only run — pass --clean to delete stale keys)"
fi
