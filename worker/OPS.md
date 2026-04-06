# Cloudflare Worker — Operations Guide

This document covers everything you need to manage the CandleScan Cloudflare Worker,
including resetting your passphrase, managing RSA keys, redeploying, and troubleshooting.

**Only the Cloudflare account owner can run these commands.** The worker is deployed
under your Cloudflare account. Anyone else running these commands will get auth errors
because `wrangler` authenticates via your browser login or API token.

## Table of Contents
- [Prerequisites](#prerequisites)
- [1. Reset Passphrase](#1-reset-passphrase)
- [2. RSA Key Management](#2-rsa-key-management)
- [3. Redeploy the Worker](#3-redeploy-the-worker)
- [4. First-Time Setup](#4-first-time-setup-from-scratch)
- [5. Check Current Status](#5-check-current-status)
- [6. Troubleshooting](#6-troubleshooting)
- [7. PWA Auto-Updates](#7-pwa-auto-updates)
- [8. Rate Limit Configuration](#8-rate-limit-configuration)
- [9. Worker Allowed Origins](#9-worker-allowed-origins)
- [10. Worker URL](#10-worker-url)
- [11. Zerodha Proxy](#11-zerodha-proxy)
- [Security Notes](#security-notes)

---

## Prerequisites

You need **Node.js** (v18+) and **npx** (comes with Node). Nothing else to install.

```bash
# Verify you have them
node --version    # should print v18.x or higher
npx --version     # should print 7.x or higher
```

---

## 1. Reset Passphrase

When you want to change the passphrase used for premium features.

### Step 1: Generate the new hash

Pick a new passphrase. Run this to get its SHA-256 hash:

```bash
echo -n "YOUR_NEW_PASSPHRASE_HERE" | shasum -a 256 | awk '{print $1}'
```

**Important:** The `-n` flag is critical — without it, a newline is included and the
hash will be different. Keep the quotes around your passphrase.

Example:
```bash
echo -n "mySuperSecret123" | shasum -a 256 | awk '{print $1}'
# Output: a1b2c3d4e5f6... (64 hex characters)
```

Copy the 64-character hex output.

### Step 2: Update the secret in Cloudflare

```bash
cd worker
npx wrangler secret put GATE_PASSPHRASE_HASH
```

It will prompt: `Enter a secret value:` — paste the hash from Step 1 and press Enter.

That's it. The new passphrase is active immediately. No deploy needed — secrets are
separate from code.

### Step 3: Update your device

On your phone/browser where you use CandleScan:
1. Open the app
2. Go to Index Scanner (hamburger menu)
3. Tap "Scan All" — it will fail with "Invalid passphrase"
4. Enter your **new** passphrase (the plain text, not the hash)
5. It will be saved in localStorage for future use

---

## 2. RSA Key Management

The RSA key pair is used to encrypt Zerodha credentials at rest in the browser.
Only the CF Worker (holding the private key) can decrypt them.

### Rotate RSA Keys

Run the rotation script from the repo root:

```bash
./scripts/rotate-keys.sh
```

This will:
1. Generate a new RSA-2048 key pair
2. Prompt for the premium passphrase
3. Deploy keys to the CF Worker (`GATE_PRIVATE_KEY` secret + `GATE_PUBLIC_KEY` in KV)
4. Clean up local key files

**After rotation**: All users must re-enter their Zerodha credentials in Settings.

---

## 3. Redeploy the Worker

When you've changed the worker code (`worker/index.js`) and need to push it live.

```bash
cd worker
npx wrangler deploy
```

This uploads `index.js` to Cloudflare and restarts the worker. Takes ~5 seconds.
Your secrets and KV data are not affected by redeployments.

---

## 4. First-Time Setup (from scratch)

If you ever need to set up the worker from zero (new Cloudflare account, etc.):

### Step 1: Login to Cloudflare

```bash
npx wrangler login
```

This opens a browser window. Log in with your Cloudflare account and authorize Wrangler.

### Step 2: Create the KV namespaces

```bash
cd worker

# Rate limiting namespace
npx wrangler kv namespace create RATE_LIMIT

# App data namespace (stores public key, etc.)
npx wrangler kv namespace create CANDLESCAN_KV
```

Each command will output something like:
```
{ binding = "RATE_LIMIT", id = "abc123def456..." }
{ binding = "CANDLESCAN_KV", id = "xyz789..." }
```

Copy the `id` values.

### Step 3: Update wrangler.toml

Open `worker/wrangler.toml` and replace the KV namespace ids:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "PASTE_RATE_LIMIT_ID_HERE"

[[kv_namespaces]]
binding = "CANDLESCAN_KV"
id = "PASTE_CANDLESCAN_KV_ID_HERE"
```

### Step 4: Set the passphrase hash

Generate your hash (see Section 1, Step 1), then:

```bash
npx wrangler secret put GATE_PASSPHRASE_HASH
# Paste the 64-char hex hash when prompted
```

### Step 5: Deploy RSA keys

Run the rotation script to generate and deploy the RSA key pair:

```bash
cd ..
./scripts/rotate-keys.sh
```

This sets the `GATE_PRIVATE_KEY` secret and stores `GATE_PUBLIC_KEY` in the
`CANDLESCAN_KV` namespace.

### Step 6: Deploy

```bash
cd worker
npx wrangler deploy
```

### Step 7: Verify

```bash
# Should return 400 (no url param) — means the worker is running
curl -s -o /dev/null -w "%{http_code}" https://candlescan-proxy.utkarsh-dev.workers.dev/
```

---

## 5. Check Current Status

### See deployed worker info
```bash
cd worker
npx wrangler deployments list
```

### See what secrets are set (names only, not values)
```bash
npx wrangler secret list
```

### Check rate limit KV entries
```bash
# List all keys (rate limit counters)
npx wrangler kv key list --binding RATE_LIMIT

# Delete a specific key (to unblock an IP for today)
npx wrangler kv key delete --binding RATE_LIMIT "rl:SOME_KEY_HERE"
```

---

## 6. Troubleshooting

### "wrangler: command not found"
You don't need to install wrangler globally. Always use `npx wrangler ...` which
downloads and runs it on the fly.

### "Not logged in"
Run `npx wrangler login` — it opens a browser for Cloudflare auth.

### "Authentication error" or 403 from wrangler commands
You're not logged into the right Cloudflare account. Run:
```bash
npx wrangler whoami
```
This shows which account you're authenticated as. If wrong:
```bash
npx wrangler logout
npx wrangler login
```

### Worker returns 403 for premium features
Your passphrase hash doesn't match. Reset it (Section 1).

### Worker returns 429
Rate limit hit (20 req/day per IP). Wait until tomorrow, or use your
gate token (which bypasses rate limits).

### KV namespace error on deploy
The KV namespace id in `wrangler.toml` doesn't match your account.
Recreate it (Section 4, Steps 2-3).

---

## 7. PWA Auto-Updates

The CandleScan PWA uses Workbox with `registerType: 'autoUpdate'`. This means:

- When you deploy a new version (push to `main` → GitHub Actions → Pages), a new
  service worker is generated with updated asset hashes.
- On the user's next visit, the browser detects the new SW in the background.
- The new SW activates and replaces the old one **automatically** — no user action needed.
- Cached assets are refreshed to match the new build.

**You don't need to do anything** — the PWA updates itself whenever the frontend is redeployed.

### Force update on your device
If the auto-update hasn't kicked in:
1. Open the app
2. Pull down to refresh (or reload the page)
3. Close and reopen the app

### Check current version
Open browser DevTools → Application → Service Workers. The "Source" column shows
the current SW file hash — a new hash means a new version was loaded.

---

## 8. Rate Limit Configuration

The daily request limit for unauthenticated users is set to **20** in `worker/index.js`:

```javascript
const DAILY_LIMIT = 20;
```

To change it:
1. Edit the number in `worker/index.js`
2. Redeploy: `cd worker && npx wrangler deploy`

KV entries auto-expire after 24 hours (TTL 86400s). No cleanup needed.

### View current rate limit data
```bash
cd worker
npx wrangler kv key list --binding RATE_LIMIT
```

### Unblock a specific IP early
```bash
# Find the key from the list above (format: rl:<hash>:<date>)
npx wrangler kv key delete --binding RATE_LIMIT "rl:abc123:2026-03-29"
```

---

## 9. Worker Allowed Origins

The worker only accepts requests from these origins:

```javascript
'https://utkarsh9891.github.io'  // GitHub Pages
'http://localhost'                // Dev server
'http://127.0.0.1'               // Dev server (IP)
'https://localhost'               // Capacitor (Android PWA)
'capacitor://localhost'           // Capacitor native
```

To add a new origin, edit `ALLOWED_ORIGINS` in `worker/index.js` and redeploy.

---

## 10. Worker URL

The worker is deployed at:
```
https://candlescan-proxy.utkarsh-dev.workers.dev
```

This URL is hardcoded in `src/engine/fetcher.js` as `CF_WORKER_URL`. If you ever
change the worker name or Cloudflare account, update this constant and redeploy
both the worker and the frontend.

---

## 11. Zerodha Proxy

The Worker proxies Zerodha Kite API calls for premium users.

### How it works
1. Browser sends RSA-encrypted credentials + gate token to `POST /zerodha/historical`
2. Worker validates gate token
3. Worker decrypts credentials with `GATE_PRIVATE_KEY`
4. Worker calls `api.kite.trade` with decrypted credentials
5. Worker returns OHLCV data, discards credentials

### Troubleshooting
- **403 on `/zerodha/historical`**: Invalid gate token or not configured
- **400 "Failed to decrypt"**: Keys were rotated, user needs to re-enter credentials in Settings
- **502 "Kite API fetch failed"**: Zerodha API is down or access token expired

---

## Security Notes

- **Secrets are safe.** `GATE_PASSPHRASE_HASH` is stored in Cloudflare's encrypted
  environment. It never appears in code, logs, or API responses.
- **Only you can manage secrets.** Wrangler authenticates via your Cloudflare
  account. Anyone else running these commands gets an auth error.
- **The hash is one-way.** Even if someone obtained the hash, they cannot
  reverse it to get your passphrase.
- **RSA encryption protects credentials.** Zerodha credentials are encrypted in
  the browser using `GATE_PUBLIC_KEY` (RSA-2048). Only the CF Worker can decrypt
  them with `GATE_PRIVATE_KEY`. Credentials are never stored on the server — they
  are decrypted in memory, used for a single API call, and discarded.
- **Source code is safe to be public.** The repo contains no secrets — only the
  KV namespace id (not sensitive) and the worker code.

### Secrets & KV reference

| Name | Type | Purpose |
|------|------|---------|
| `GATE_PASSPHRASE_HASH` | Secret | SHA-256 hex of the premium passphrase |
| `GATE_PRIVATE_KEY` | Secret | RSA private key PEM for vault decryption |
| `GATE_PUBLIC_KEY` | KV (`CANDLESCAN_KV`) | RSA public key served to authenticated users |
