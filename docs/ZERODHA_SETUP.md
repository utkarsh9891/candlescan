# Zerodha Kite Connect — Setup Guide

## Table of Contents
- [Prerequisites](#prerequisites)
- [Step 1: Create a Kite Connect App](#step-1-create-a-kite-connect-app)
- [Step 2: Deploy RSA Keys (Admin Only)](#step-2-deploy-rsa-keys-admin-only)
- [Step 3: Unlock Premium in CandleScan](#step-3-unlock-premium-in-candlescan)
- [Step 4: Configure Zerodha Credentials](#step-4-configure-zerodha-credentials)
- [Daily Token Refresh](#daily-token-refresh)
- [Security Model](#security-model)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites
- Active Zerodha trading account
- Kite Connect API subscription (₹2000/month from Zerodha developer portal)
- Premium passphrase for CandleScan (provided by the app admin)

---

## Step 1: Create a Kite Connect App
1. Go to https://developers.kite.trade/
2. Log in with your Zerodha credentials
3. Create a new app:
   - App name: anything (e.g., "CandleScan")
   - Redirect URL: `https://utkarsh9891.github.io/candlescan/` (or your deployment URL)
4. Note your **API Key** and **API Secret**

---

## Step 2: Deploy RSA Keys (Admin Only)
This is a one-time setup done by the CandleScan admin.

```bash
cd /path/to/candlescan
./scripts/rotate-keys.sh
```

This generates an RSA key pair, hashes the premium passphrase, and deploys everything to the Cloudflare Worker.

---

## Step 3: Unlock Premium in CandleScan
1. Open CandleScan app
2. Go to Settings (hamburger menu → Settings)
3. Enter the premium passphrase in the "Premium Gate" section
4. Click "Unlock"
5. You should see "Premium Active" status

---

## Step 4: Configure Zerodha Credentials
1. In Settings, select "Zerodha Kite" as the data source
2. Enter your:
   - **API Key**: from Step 1
   - **API Secret**: from Step 1
   - **Access Token**: obtained via the Zerodha login flow (see Daily Token Refresh)
3. Click "Encrypt & Save"
4. Click "Test Connection" to verify

---

## Daily Token Refresh

Zerodha access tokens expire daily at ~6 AM IST. You need to get a new one each trading day.

### Getting an Access Token

1. Open your browser and navigate to:
   ```
   https://kite.zerodha.com/connect/login?v=3&api_key=YOUR_API_KEY
   ```
2. Log in with your Zerodha credentials + 2FA
3. After successful login, you'll be redirected to your redirect URL with a `request_token` parameter:
   ```
   https://your-redirect-url/?request_token=XXXXX&action=login&status=success
   ```
4. Copy the `request_token` value
5. Generate the access token using the Kite API:
   ```bash
   # checksum = SHA256(api_key + request_token + api_secret)
   curl -X POST https://api.kite.trade/session/token \
     -d "api_key=YOUR_API_KEY" \
     -d "request_token=YOUR_REQUEST_TOKEN" \
     -d "checksum=YOUR_CHECKSUM"
   ```
6. Copy the `access_token` from the response
7. Go to CandleScan Settings → update the Access Token → "Encrypt & Save"

### Quick Token Generation (Python)
```python
from kiteconnect import KiteConnect
kite = KiteConnect(api_key="YOUR_API_KEY")
# After login, generate session:
data = kite.generate_session("REQUEST_TOKEN", api_secret="YOUR_API_SECRET")
print(data["access_token"])
```

---

## Security Model

Your Zerodha credentials are protected by multiple layers:

| Layer | Protection |
|-------|-----------|
| **At rest (browser)** | RSA-OAEP encrypted with CF Worker's public key. Only the server can decrypt. |
| **In transit** | HTTPS/TLS encryption |
| **On server** | CF Worker decrypts, uses, then immediately discards credentials. Never logged or stored. |
| **Access control** | Premium passphrase required to even obtain the RSA public key |

**Key points**:
- Plaintext credentials are NEVER stored in the browser
- Even if someone accesses your localStorage, they see only RSA-encrypted blobs
- The RSA private key never leaves the Cloudflare Worker environment
- Source code being public doesn't compromise security — the private key is a server secret

---

## Troubleshooting

| Issue | Solution |
|-------|---------|
| "Invalid passphrase" on unlock | Check passphrase with the app admin |
| "Public key not configured" | Admin needs to run `scripts/rotate-keys.sh` |
| "Failed to decrypt credentials" | RSA keys were rotated — re-enter your Zerodha credentials |
| "Kite API error: 403" | Access token expired — get a new one (see Daily Token Refresh) |
| "Kite API error: 429" | Zerodha rate limit hit — wait a few seconds and retry |
| Test connection fails | Check API key/secret/token are correct; ensure Kite Connect subscription is active |
| No data returned | Symbol may not be available on NSE; verify on Kite web |

---

**Educational only — not financial advice.**
