# Cloudflare Worker — Operations Guide

This document covers everything you need to manage the CandleScan Cloudflare Worker,
including resetting your passphrase, redeploying, and troubleshooting.

**Only the Cloudflare account owner can run these commands.** The worker is deployed
under your Cloudflare account. Anyone else running these commands will get auth errors
because `wrangler` authenticates via your browser login or API token.

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

When you want to change the passphrase used for batch scanning.

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
npx wrangler secret put BATCH_AUTH_HASH
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

## 2. Redeploy the Worker

When you've changed the worker code (`worker/index.js`) and need to push it live.

```bash
cd worker
npx wrangler deploy
```

This uploads `index.js` to Cloudflare and restarts the worker. Takes ~5 seconds.
Your secrets and KV data are not affected by redeployments.

---

## 3. First-Time Setup (from scratch)

If you ever need to set up the worker from zero (new Cloudflare account, etc.):

### Step 1: Login to Cloudflare

```bash
npx wrangler login
```

This opens a browser window. Log in with your Cloudflare account and authorize Wrangler.

### Step 2: Create the KV namespace for rate limiting

```bash
cd worker
npx wrangler kv namespace create RATE_LIMIT
```

It will output something like:
```
{ binding = "RATE_LIMIT", id = "abc123def456..." }
```

Copy the `id` value.

### Step 3: Update wrangler.toml

Open `worker/wrangler.toml` and replace the KV namespace id:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "PASTE_THE_ID_HERE"
```

### Step 4: Set the passphrase hash

Generate your hash (see Section 1, Step 1), then:

```bash
npx wrangler secret put BATCH_AUTH_HASH
# Paste the 64-char hex hash when prompted
```

### Step 5: Deploy

```bash
npx wrangler deploy
```

### Step 6: Verify

```bash
# Should return 400 (no url param) — means the worker is running
curl -s -o /dev/null -w "%{http_code}" https://candlescan-proxy.utkarsh-dev.workers.dev/
```

---

## 4. Check Current Status

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

## 5. Troubleshooting

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

### Worker returns 403 for batch scans
Your passphrase hash doesn't match. Reset it (Section 1).

### Worker returns 429
Rate limit hit (20 req/day per IP). Wait until tomorrow, or use your
batch token (which bypasses rate limits).

### KV namespace error on deploy
The KV namespace id in `wrangler.toml` doesn't match your account.
Recreate it (Section 3, Steps 2-3).

---

## 6. PWA Auto-Updates

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

## 7. Rate Limit Configuration

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

## 8. Worker Allowed Origins

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

## 9. Worker URL

The worker is deployed at:
```
https://candlescan-proxy.utkarsh-dev.workers.dev
```

This URL is hardcoded in `src/engine/fetcher.js` as `CF_WORKER_URL`. If you ever
change the worker name or Cloudflare account, update this constant and redeploy
both the worker and the frontend.

---

## Security Notes

- **Secrets are safe.** `BATCH_AUTH_HASH` is stored in Cloudflare's encrypted
  environment. It never appears in code, logs, or API responses.
- **Only you can manage secrets.** Wrangler authenticates via your Cloudflare
  account. Anyone else running these commands gets an auth error.
- **The hash is one-way.** Even if someone obtained the hash, they cannot
  reverse it to get your passphrase.
- **Source code is safe to be public.** The repo contains no secrets — only the
  KV namespace id (not sensitive) and the worker code.
