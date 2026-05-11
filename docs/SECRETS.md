# Secrets — where everything lives

Every key, secret, hash, and token in CandleScan, listed in one place.
This page is the authoritative storage map; other docs link here for
specifics.

## Contents

- [Nomenclature: PWA, Worker, Cockpit](#nomenclature-pwa-worker-cockpit)
- [Quick reference matrix](#quick-reference-matrix)
- [The two gates (PWA vs Cockpit)](#the-two-gates-pwa-vs-cockpit)
- [PWA premium gate (Worker-side, RSA)](#pwa-premium-gate-worker-side-rsa)
- [Cockpit gate (Mac-side, PBKDF2 + AES-GCM)](#cockpit-gate-mac-side-pbkdf2--aes-gcm)
- [Dhan credentials](#dhan-credentials)
- [Zerodha credentials](#zerodha-credentials)
- [ntfy topic](#ntfy-topic)
- [How to rotate / change anything](#how-to-rotate--change-anything)

## Nomenclature: PWA, Worker, Cockpit

The system has three runtimes; they each store and use different
secrets. Wherever this doc says "where it lives", it's one of these:

| Term | What | Where it physically runs |
|---|---|---|
| **PWA** | The deployed React app at `utkarsh9891.github.io/candlescan/` | User's browser (mobile or desktop) |
| **Worker** | The Cloudflare Worker proxy `candlescan-proxy.utkarsh-dev.workers.dev` | Cloudflare's edge |
| **Cockpit** | The Mac-side scan + paper-trade daemon (sometimes called "autopilot" or "terminal mode" — it's all the same thing) | Your Mac, started with `npm run cockpit:start` |

The Cockpit talks directly to Yahoo + NSE — it does not go through the
Worker. The PWA goes through the Worker for CORS reasons and for
gate-protected broker proxying.

## Quick reference matrix

| Secret | Lives in | Format | Encrypted at rest? | Set / rotated by |
|---|---|---|---|---|
| **PWA premium passphrase** | your head + password manager | plain | n/a | manual (you remember it) |
| **PWA premium passphrase hash** (`GATE_PASSPHRASE_HASH`) | Worker secret | SHA-256 hex | yes (CF-managed) | `npm run worker:rotate-keys` |
| **RSA public key** (`GATE_PUBLIC_KEY`) | Worker KV — `CANDLESCAN_CONFIG` | PEM | no (it's public) | `npm run worker:rotate-keys` |
| **RSA private key** (`GATE_PRIVATE_KEY`) | Worker secret | PEM | yes (CF-managed) | `npm run worker:rotate-keys` |
| **Browser-side encrypted vault** (Zerodha / Dhan creds for the PWA) | browser `localStorage` | RSA-OAEP-2048 ciphertext | yes (decryptable only by Worker) | PWA Settings UI |
| **PWA gate token** (per-device passphrase hash) | browser `localStorage` | SHA-256 hex | no (already a hash) | PWA Settings → Premium Gate |
| **Cockpit gate config** (`gate.salt` + `gate.verifier`) | `~/.candlescan/cockpit/secrets.json` (Mac) | PBKDF2-SHA256 verifier hex | n/a (verifier, not the passphrase) | `npm run cockpit:gate -- set` |
| **Cockpit gate passphrase** | your head + password manager | plain | n/a | `npm run cockpit:gate -- set` |
| **ntfy topic** | `~/.candlescan/cockpit/secrets.json` (Mac) | random hex string | yes if cockpit gate set | `cockpit:init` / `cockpit:rotate-topic` |
| **Dhan client ID** | `~/.candlescan/cockpit/secrets.json` (Mac) | plain string | no (not a secret per se) | `npm run cockpit:dhan` |
| **Dhan PIN** | `~/.candlescan/cockpit/secrets.json` (Mac) | plain | yes if cockpit gate set | `npm run cockpit:dhan` |
| **Dhan TOTP** | NEVER stored | n/a | n/a | prompted at daemon launch — only when the cached access token is missing / expired |
| **Dhan access token (cockpit, daily)** | `~/.candlescan/cockpit/secrets.json` (Mac) | encrypted (cockpit gate) | **always — gate is required** | written at first boot's TOTP exchange; reused for the rest of its ~24h window; refreshed when expired |
| **Zerodha API key** | `~/.candlescan/cockpit/secrets.json` (Mac) | plain | no (key is public-ish) | `npm run cockpit:zerodha` |
| **Zerodha API secret** | `~/.candlescan/cockpit/secrets.json` (Mac) | plain | yes if cockpit gate set | `npm run cockpit:zerodha` |
| **Zerodha access token (cockpit, daily)** | `~/.candlescan/cockpit/secrets.json` (Mac) | plain | yes if cockpit gate set | `npm run cockpit:zerodha -- access-token` daily |

## The two gates (PWA vs Cockpit)

**This is the single biggest source of confusion.** They share the word
"gate" but are completely separate systems. Same person uses both, but
they don't talk to each other.

|  | PWA gate | Cockpit gate |
|---|---|---|
| Lives in | Cloudflare (Worker secret + KV) + browser localStorage | `~/.candlescan/cockpit/secrets.json` on your Mac |
| Crypto | RSA-OAEP-2048 (vault) + SHA-256 hash (passphrase) | PBKDF2-SHA256 (verifier) + AES-256-GCM (field encryption) |
| What it gates | Premium-tier broker access via the Worker for the PWA | Reading sensitive fields out of secrets.json on the Mac |
| Configured via | `npm run worker:rotate-keys` | `npm run cockpit:gate -- set` |
| When you'd rotate it | RSA keys aged out / suspect leak / new passphrase | Suspect a backup leak / want a different passphrase |
| Required for cockpit operation? | **No** — cockpit doesn't call Worker | Optional but recommended; defends against backups |

You can reasonably have neither, only the PWA gate, only the Cockpit
gate, or both. Each one independently protects its own surface.

## PWA premium gate (Worker-side, RSA)

The PWA gate-protects access to the Worker's premium endpoints
(`/zerodha/*`, `/dhan/*`). Designed so:

- Your premium passphrase **never leaves your browser**. It's hashed
  client-side; only the SHA-256 hex hits the Worker as `X-Gate-Token`.
- Broker creds (Zerodha / Dhan API key + secret + access token) are
  RSA-encrypted in your browser using the public key, stored as ciphertext
  in `localStorage`, sent to the Worker as ciphertext on every premium
  call. **Only the Worker (with the private key) can decrypt them.**
- Rotating keys invalidates every device's encrypted vault — users have
  to re-enter their broker creds in PWA Settings after a rotation.

Storage:

| Item | Where | Notes |
|---|---|---|
| `GATE_PASSPHRASE_HASH` | Worker secret | SHA-256 hex of the passphrase. CF stores secrets encrypted at rest. |
| `GATE_PRIVATE_KEY` | Worker secret | RSA-2048 private key PEM. Same CF-managed encryption. |
| `GATE_PUBLIC_KEY` | Worker KV (`CANDLESCAN_CONFIG`) | Served to the browser via `/gate/unlock` so the PWA can encrypt new vault data. |
| Browser vault blob | localStorage | RSA-OAEP ciphertext containing Zerodha apiKey/secret/accessToken (or Dhan equivalents). |
| Browser gate token | localStorage | SHA-256 hex of the passphrase. Sent as `X-Gate-Token` header. |

Rotation: a single command does everything in one transaction —
generate new RSA pair, hash the new passphrase, upload all three to CF,
clean up local key files.

```bash
npm run worker:rotate-keys     # interactive — prompts for the new passphrase
```

After rotation, every device using the PWA must re-enter its broker
creds in Settings (the old vault blob is undecryptable with the new
private key).

Full step-by-step + troubleshooting: [`docs/WORKER_OPS.md`](WORKER_OPS.md).

## Cockpit gate (Mac-side, PBKDF2 + AES-GCM)

Optional passphrase that encrypts sensitive fields **inside
`~/.candlescan/cockpit/secrets.json`** at rest:

- `ntfy.topic`
- `dhan.pin`
- `zerodha.apiSecret`
- `zerodha.accessToken`

Why bother when the file is already mode `0600`?

- Mode `0600` only stops *other Unix users* from reading. It does not
  stop:
  - Time Machine copies (the backup volume gets the file unencrypted)
  - iCloud Drive / Dropbox / `rsync` to a NAS — anything sync'ing `~/`
  - Any process running as your user (browsers, IDEs, anything)
  - Casual `cat secrets.json` while you're away from the Mac
- With a gate set, the file at rest contains only ciphertext for those
  fields. Decryption requires the passphrase, which lives in your head +
  password manager — never on disk.

Crypto: PBKDF2-SHA256 (200k iterations) → AES-256-GCM (12-byte IV,
embedded auth tag). Verifier comparison is constant-time. Salt is
16 bytes. Implementation: [`scripts/cockpit/lib/gate.mjs`](../scripts/cockpit/lib/gate.mjs).

Once a gate is set, the cockpit daemon prompts for the passphrase on
startup (max 3 attempts). The cockpit launches manually (no auto-start
infrastructure), so this is just an extra step in your morning startup.

```bash
npm run cockpit:gate            # show status (default)
npm run cockpit:gate -- set     # set or change passphrase
npm run cockpit:gate -- clear   # remove gate (decrypts back to plain)
npm run cockpit:gate -- test    # verify a passphrase
```

## Dhan credentials

Dhan broker auth uses three things: client ID, PIN, and a 30-second
TOTP. We only store the first two; the TOTP changes every 30s and is
prompted interactively at cockpit startup.

| Surface | What's stored | Where | Encrypted? |
|---|---|---|---|
| **PWA** | Client ID (plain in localStorage), encrypted PIN (in Worker vault), encrypted access token (in Worker vault) | browser localStorage + Worker round-trip for premium calls | RSA via Worker |
| **Cockpit** | clientId + pin in `~/.candlescan/cockpit/secrets.json` | Mac local file (mode 0600) | **always — gate is required** (PBKDF2 + AES-256-GCM) |
| **Cockpit (runtime)** | accessToken (derived from clientId+PIN+TOTP at boot) | in-memory only | n/a |

Cockpit setup (`cockpit:gate -- set` is a prerequisite):

```bash
npm run cockpit:gate -- set         # one-time: set the encryption passphrase
npm run cockpit:dhan                # interactive: clientId + PIN
npm run cockpit:dhan -- show        # show what's stored (redacted summary)
npm run cockpit:dhan -- clear       # remove from secrets.json
```

Without a gate, `cockpit:dhan` exits with a non-zero status and a
message pointing at `cockpit:gate set`. PINs cannot be stored in
plaintext.

> **Note on cockpit data path**: the cockpit's scan loop currently uses
> Yahoo (anonymous, free, ~1-min delayed). Live Dhan/Zerodha integration
> is wiring up next — `scan.dataSource` config field already exists
> (defaults to `yahoo`), and the Dhan/Zerodha live OHLCV fetchers are
> the next iteration's work. The CLI already lets you store creds today
> so they're ready when the wiring lands.

## Zerodha credentials

Zerodha Kite Connect auth uses an API key + API secret (long-lived,
configured per Kite developer app) and a daily access token (rotates
every morning around 06:00 IST after their OAuth flow).

| Surface | What's stored | Where | Encrypted? |
|---|---|---|---|
| **PWA** | API key + secret + access token, all in Worker vault | browser localStorage (vault blob) + Worker decrypts on each premium call | RSA via Worker |
| **Cockpit** | apiKey + apiSecret + accessToken in `~/.candlescan/cockpit/secrets.json` | Mac local file (mode 0600) | **always — gate is required** (apiSecret + accessToken encrypted; apiKey is plain) |

Cockpit setup (`cockpit:gate -- set` is a prerequisite):

```bash
npm run cockpit:gate -- set               # one-time: set the encryption passphrase
npm run cockpit:zerodha                   # full setup (apiKey + apiSecret + accessToken)
npm run cockpit:zerodha -- access-token   # daily refresh — paste new token
npm run cockpit:zerodha -- show           # show what's stored (redacted)
npm run cockpit:zerodha -- clear          # remove from secrets.json
```

Daily rotation via the PWA's OAuth flow is still the simplest path —
log in via the PWA Settings, copy the resulting access token, paste it
into `cockpit:zerodha -- access-token`. Programmatic OAuth from the
cockpit is not implemented.

## ntfy topic

The push-notification topic for cockpit-to-phone alerts. The topic name
**is the auth** — anyone who knows it can read your alerts and push
spoofed alerts to your phone. Treat it like a password.

| Where | Format | Encrypted? |
|---|---|---|
| `~/.candlescan/cockpit/secrets.json` (Mac) | random 24-char hex string by default | yes if cockpit gate is set |
| Phone (ntfy app) | subscribed topic name | no (the app needs it plain to subscribe) |
| `ntfy.sh` servers | the topic is by definition known to ntfy.sh | their TLS, but they see the topic |
| Forcepoint / corporate edge | if TLS-inspected, they see the POST body containing the topic | corporate visibility |

Rotation:

```bash
npm run cockpit:rotate-topic
```

This generates a new topic, prints it to your terminal **and only
there** (no notification sent on the old topic — if the old topic was
leaked, that channel is treated as untrusted), and updates
`secrets.json`. Then on your phone: subscribe to the new topic in the
ntfy app, unsubscribe from the old.

## How to rotate / change anything

| What | Command | Side effects |
|---|---|---|
| PWA premium passphrase + RSA keys | `npm run worker:rotate-keys` | All users must re-enter Zerodha/Dhan creds in PWA Settings |
| Cockpit gate passphrase | `npm run cockpit:gate -- set` | None — encrypted fields stay encrypted with the new key |
| Remove cockpit gate (decrypt back to plain) | `npm run cockpit:gate -- clear` | secrets.json is plain text again (still mode 0600) |
| Dhan PIN | `npm run cockpit:dhan` (re-enter all) | TOTP still prompted at next boot |
| Zerodha access token (daily) | `npm run cockpit:zerodha -- access-token` | None |
| ntfy topic | `npm run cockpit:rotate-topic` | Resubscribe in ntfy app on phone |

To audit or clean Worker KV state: `npm run worker:audit-kv` (read-only)
or `npm run worker:audit-kv -- --clean` (deletes stale keys). See
[`docs/WORKER_OPS.md`](WORKER_OPS.md).
