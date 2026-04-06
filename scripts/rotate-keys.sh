#!/usr/bin/env bash
set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()    { echo -e "${YELLOW}[info]${NC}  $*"; }
success() { echo -e "${GREEN}[ok]${NC}    $*"; }
error()   { echo -e "${RED}[error]${NC} $*" >&2; }

# ── Cleanup trap — always remove temp keys, even on failure ──────────
cleanup() { rm -f /tmp/candlescan_gate_private.pem /tmp/candlescan_gate_public.pem; }
trap cleanup EXIT

# ── Pre-flight checks ────────────────────────────────────────────────
if [[ ! -d "worker" ]]; then
  error "Must be run from the repo root (worker/ directory not found)."
  exit 1
fi

if ! command -v openssl &>/dev/null; then
  error "openssl is not installed or not in PATH."
  exit 1
fi

if ! command -v npx &>/dev/null; then
  error "npx is not installed or not in PATH (needed for wrangler)."
  exit 1
fi

# ── Confirmation (random word challenge) ──────────────────────────────
WORDS=("rotate" "deploy" "confirm" "unlock" "launch" "ignite" "proceed" "execute" "engage" "commit")
CHALLENGE="${WORDS[$((RANDOM % ${#WORDS[@]}))]}"
echo ""
info "This will rotate the RSA key pair and update the CF Worker secrets."
info "All existing encrypted vaults will be invalidated."
echo ""
read -rp "Type '${CHALLENGE}' to continue: " answer
if [[ "${answer}" != "${CHALLENGE}" ]]; then
  error "Incorrect. Aborted."
  exit 0
fi

# ── Generate RSA-2048 key pair ────────────────────────────────────────
info "Generating RSA-2048 key pair…"
openssl genrsa -out /tmp/candlescan_gate_private.pem 2048 2>/dev/null
openssl rsa -in /tmp/candlescan_gate_private.pem -pubout -out /tmp/candlescan_gate_public.pem 2>/dev/null
success "Key pair generated."

# ── Prompt for premium passphrase ─────────────────────────────────────
echo ""
read -rsp "Enter premium passphrase: " passphrase
echo ""

if [[ -z "${passphrase}" ]]; then
  error "Passphrase cannot be empty."
  exit 1
fi

hash=$(echo -n "${passphrase}" | shasum -a 256 | awk '{print $1}')
success "Passphrase hashed."

# ── Deploy to CF Worker ───────────────────────────────────────────────
info "Deploying secrets to CF Worker…"

(
  cd worker

  info "Uploading GATE_PRIVATE_KEY…"
  npx wrangler secret put GATE_PRIVATE_KEY < /tmp/candlescan_gate_private.pem

  info "Uploading GATE_PASSPHRASE_HASH…"
  npx wrangler secret put GATE_PASSPHRASE_HASH <<< "${hash}"

  # ── Ensure CANDLESCAN_KV namespace exists ───────────────────────────
  KV_ID=$(grep -A2 'binding = "CANDLESCAN_KV"' wrangler.toml | grep 'id = ' | sed 's/.*id = "\(.*\)"/\1/')

  if [[ -z "${KV_ID}" || "${KV_ID}" == "REPLACE_WITH_ACTUAL_KV_ID" ]]; then
    info "CANDLESCAN_KV namespace not configured. Creating it now…"
    CREATE_OUTPUT=$(npx wrangler kv namespace create CANDLESCAN_KV 2>&1)
    echo "${CREATE_OUTPUT}"

    # Extract the namespace ID from wrangler output (format: id = "abc123...")
    NEW_KV_ID=$(echo "${CREATE_OUTPUT}" | grep -oE 'id = "[a-f0-9]+"' | head -1 | sed 's/id = "\(.*\)"/\1/')

    if [[ -z "${NEW_KV_ID}" ]]; then
      error "Failed to extract KV namespace ID from wrangler output."
      error "Create it manually: npx wrangler kv namespace create CANDLESCAN_KV"
      exit 1
    fi

    # Update wrangler.toml with the new ID
    if grep -q 'REPLACE_WITH_ACTUAL_KV_ID' wrangler.toml; then
      sed -i '' "s/REPLACE_WITH_ACTUAL_KV_ID/${NEW_KV_ID}/" wrangler.toml
    else
      # Append the KV binding if it doesn't exist at all
      printf '\n[[kv_namespaces]]\nbinding = "CANDLESCAN_KV"\nid = "%s"\n' "${NEW_KV_ID}" >> wrangler.toml
    fi

    KV_ID="${NEW_KV_ID}"
    success "CANDLESCAN_KV namespace created (${KV_ID}) and wrangler.toml updated."
  fi

  info "Uploading GATE_PUBLIC_KEY to KV…"
  npx wrangler kv key put --namespace-id="${KV_ID}" "GATE_PUBLIC_KEY" --path /tmp/candlescan_gate_public.pem --remote

  # ── Deploy the worker code ──────────────────────────────────────────
  info "Deploying worker code…"
  npx wrangler deploy
)

success "Secrets deployed and worker updated."

echo ""
success "Keys rotated successfully. Existing encrypted vaults will need to be re-created."
