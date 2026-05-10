# CandleScan Cockpit

Mac-side daemon that runs the scan loop, pushes high-confidence signals to your
phone via [ntfy](https://ntfy.sh), exposes a small HTTP server + web UI for
paper-trade entry from the phone, and runs an exit monitor against open paper
trades that auto-exits on SL/target/EOD with notifications.

The cockpit is a Mac-only complement to the deployed PWA — scans run on the
Mac (reliable; never killed by Android), the PWA stays as the chart-viewing
surface on the phone.

## Table of contents

- [Architecture](#architecture)
- [First-run setup](#first-run-setup)
- [CLI reference](#cli-reference)
  - [`cockpit:start` (daemon)](#cockpitstart-daemon)
  - [`cockpit:init`](#cockpitinit)
  - [`cockpit:status`](#cockpitstatus)
  - [`cockpit:config`](#cockpitconfig)
  - [`cockpit:dhan`](#cockpitdhan)
  - [`cockpit:zerodha`](#cockpitzerodha)
  - [`cockpit:gate`](#cockpitgate)
  - [`cockpit:rotate-topic`](#cockpitrotate-topic)
  - [`cockpit:logs`](#cockpitlogs)
  - [`cockpit:help`](#cockpithelp)
- [How this differs from the PWA's gate](#how-this-differs-from-the-pwas-gate)
- [Configurable knobs (`secrets.json`)](#configurable-knobs-secretsjson)
- [Files + data layout](#files--data-layout)
- [Trade flow walkthrough](#trade-flow-walkthrough)
- [Known limitations + deferred polish](#known-limitations--deferred-polish)

## Architecture

```
                ┌─────────────────────────────────────────┐
                │          Mac (cockpit.local:5174)       │
                │                                          │
   NSE ◀────────┼─ symbols (cached per IST trading day)   │
   Yahoo ◀──────┼─ OHLCV per symbol (5-way concurrency)   │
                │                                          │
                │  scan loop ──► detectPatterns           │
                │             ──► detectLiquidityBox       │
                │             ──► computeRiskScore         │
                │             ──► state.recordSignal       │
                │                                          │
                │  exit-monitor ──► fetch latest 1m        │
                │              ──► SL/target/EOD/trail    │
                │              ──► state.exitTrade        │
                │                                          │
                │  hono server  ──► /  (cockpit UI)        │
                │              ──► /api/state              │
                │              ──► /api/trades/enter       │
                │              ──► /api/trades/:id/exit    │
                │              ──► /api/events  (SSE)      │
                │                                          │
                │  notify ──► ntfy.sh ──┐                  │
                │  state  ──► ~/.candlescan/cockpit/state/ │
                └────────────────────────┼─────────────────┘
                                         │
                                         ▼
                              Phone: ntfy app → push notification
                              Phone: browser  → http://cockpit.local:5174
```

Three loops run inside one Node process:

1. **Scan loop** — every `scan.intervalSec` (default 60s), fetches index
   symbols, pulls OHLCV per stock at 5-way concurrency, runs the engine,
   filters by confidence + actionable side, persists new signals,
   notifies once per dedup key `(symbol, bar-ts, pattern)`.
2. **Exit monitor** — every `exit.intervalSec` (default 30s), checks each
   open paper trade against the latest 1m bar, applies SL/target/EOD with
   pessimistic intra-bar resolution, ratchets SL on +1.5% breakeven trail
   (long) or −1.5% (short), notifies on auto-exits.
3. **Hono HTTP server** on `host.port` (default 5174) — serves the cockpit
   web UI plus REST + SSE endpoints. Bound to `0.0.0.0` so phones on the
   LAN can reach it.

State lives at `~/.candlescan/cockpit/state/<IST-date>.json` — atomic
temp+rename writes, restart-safe dedup, per-day rollover.

## First-run setup

```bash
# 1. Install ntfy on your phone (Play Store, publisher: Philipp C. Heckel).
#    Don't subscribe yet — `cockpit init` generates the topic for you.

# 2. (recommended) Set the Mac's mDNS hostname so the phone reaches you cleanly.
sudo scutil --set LocalHostName cockpit

# 3. Run the interactive setup wizard.
npm run cockpit:init

# 4. (optional, forward-looking) Configure broker creds. The cockpit's scan
#    path currently uses anonymous Yahoo and does NOT yet read these — this
#    is preparation for the planned broker-data path.
npm run cockpit:dhan
npm run cockpit:zerodha

# 5. Start the daemon. Run this each morning when you want scanning to begin.
npm run cockpit:start

# 6. Stop it any time:
npm run cockpit:stop
```

After step 5 you should see:

- **Terminal**: colored `BOOT` lines + a `NOTIFY` line + per-tick `SCAN`
  lines + per-signal `SIGNAL ★` lines.
- **Phone**: a "Cockpit started" notification, then one notification per
  high-conf signal (with two action buttons: Enter Paper Trade, View Detail).
- **Cockpit UI**: open `http://cockpit.local:5174/` from any device on the
  same network. Live signals, open positions, closed P&L, SSE-powered
  live event stream.

Holidays are handled by [holidays.mjs](../scripts/cockpit/lib/holidays.mjs)
— the scan loop reports market-state and won't generate spurious signals
on weekends / NSE holidays.

### PWA setting

In the deployed PWA → Settings → **Cockpit (optional)** card, paste your
cockpit URL (e.g. `http://cockpit.local:5174`) and tap Save. Each device
stores its own value in `localStorage` under `candlescan_cockpit_url`, so
multiple users / devices can point at their own cockpits without colliding.

## CLI reference

Every command supports `--help` (or `-h`); the dispatcher also takes
`npm run cockpit:help <command>` for the same.

### `cockpit:start` (daemon)

```bash
npm run cockpit:start
```

Starts the daemon. Boots all three loops (scan / exit-monitor / HTTP).
Loads secrets directly from `~/.candlescan/cockpit/secrets.json`
(mode 0600).

### `cockpit:init`

```bash
npm run cockpit:init
```

Interactive first-run wizard. Prompts for ntfy topic (or generates a
random 24-hex one), Mac hostname, port, engine, index, timeframe,
confidence threshold, and scan / exit intervals. Idempotent — re-running
shows current values as defaults, so this doubles as an "edit config"
wizard for non-secret fields.

### `cockpit:status`

```bash
npm run cockpit:status
```

Quick health summary, no side effects:

- Is `secrets.json` present and complete?
- Is the daemon reachable on its configured `host.port` (HTTP `/healthz`)?
- Is the daemon currently running (pid file + pid still alive)?
- Today's signal / open / closed counts and net P&L from the state file.

Run it any time — pre-flight check, post-mortem after a session, etc.

### `cockpit:config`

```bash
npm run cockpit:config
```

Prints the current effective config with all secrets redacted. Safe to
paste into a bug report.

### `cockpit:dhan`

```bash
npm run cockpit:dhan                    # set / update creds
npm run cockpit:dhan -- show            # show stored fields (redacted summary)
npm run cockpit:dhan -- clear           # remove all Dhan creds
npm run cockpit:dhan -- --help          # full help
```

Stores: clientId, partnerId (optional), pin (hidden in the file, mode 0600).
**TOTP is not stored** — when the daemon launches and detects Dhan is
configured, it prompts for the current TOTP interactively, exchanges
(clientId + pin + TOTP) for a 24-hour access token via the Dhan auth
endpoint, and holds the token in memory for the session.

### `cockpit:zerodha`

```bash
npm run cockpit:zerodha                       # set apiKey + apiSecret + accessToken
npm run cockpit:zerodha -- access-token       # rotate ONLY the daily access token
npm run cockpit:zerodha -- show               # show stored fields (redacted summary)
npm run cockpit:zerodha -- clear              # remove all Zerodha creds
npm run cockpit:zerodha -- --help             # full help
```

Zerodha access tokens expire daily around 06:00 IST. Use `access-token`
each morning rather than re-running the full setup.

### `cockpit:gate`

```bash
npm run cockpit:gate                # show status (default)
npm run cockpit:gate -- set         # set or change passphrase
npm run cockpit:gate -- clear       # remove gate (decrypts secrets back to plain)
npm run cockpit:gate -- test        # verify a passphrase
npm run cockpit:gate -- --help      # full help
```

Optional passphrase that encrypts ntfy topic + Dhan PIN + Zerodha
apiSecret/accessToken inside `secrets.json` at rest. mode `0600` only
guards against other Unix users; the gate guards against Time Machine
backups, iCloud sync, and `cat secrets.json`.

PBKDF2-SHA256 (200k iter) + AES-256-GCM. Once set, the daemon prompts
for the passphrase at startup.

For the full storage model — what's encrypted, what isn't, where each
field lives — see [`docs/SECRETS.md`](SECRETS.md).

### `cockpit:rotate-topic`

```bash
npm run cockpit:rotate-topic
```

Generates a new random ntfy topic locally, prints it to your terminal,
and updates `secrets.json`. **Does not push anything to the old topic** —
if the old topic was leaked, sending the new value over that channel
would just leak the new one too. After running:

1. Copy the new topic from your terminal into your password manager.
2. ntfy app on phone → Subscribe to topic → paste the new topic.
3. Unsubscribe from the old.
4. Restart the daemon.

### `cockpit:logs`

```bash
npm run cockpit:logs                  # last 50 lines of today's log
npm run cockpit:logs -- -f            # follow today's log
npm run cockpit:logs -- --all         # entire today's log
npm run cockpit:logs -- 2026-04-22    # specific date (YYYY-MM-DD)
npm run cockpit:logs -- --help        # full help
```

Logs live at `~/.candlescan/cockpit/logs/<IST-date>.log` as plain text
(no ANSI codes), grep-friendly.

### `cockpit:help`

```bash
npm run cockpit:help                   # list all commands
npm run cockpit:help -- <command>      # help for a specific command
```

## Manual launch — no auto-start

The cockpit is started manually each day, whenever you want scanning to
begin. There's no launchd / cron / systemd integration, deliberately:
trading hours vary, you might want to start at 09:00 some days and 09:30
others, and a daemon that auto-launches at a fixed time you have to keep
in sync becomes its own maintenance burden.

```bash
npm run cockpit:start         # start (foreground)
npm run cockpit:stop    # SIGTERM, escalates to SIGKILL after 5s
```

`cockpit:stop` reads the pid from `~/.candlescan/cockpit/cockpit.pid`
(written by the daemon at boot), sends SIGTERM, waits up to 5 seconds for
graceful shutdown, then SIGKILLs if the process hasn't exited. Safe to run
even when the cockpit isn't running — it just reports "not running".

A double-launch is prevented: if the pidfile exists and that process is
alive, `npm run cockpit:start` refuses to start with a clear error pointing you
at `cockpit:stop`. Stale pidfiles (process crashed, file lingered) are
auto-cleaned on the next boot.

## How this differs from the PWA's gate

There are two distinct security surfaces in the project. They are
**unrelated** despite both using the word "gate":

| | **PWA gate** | **Cockpit secrets** |
|---|---|---|
| Where it lives | Cloudflare Worker (`GATE_PASSPHRASE_HASH` secret + `GATE_PUBLIC_KEY` in KV) + browser localStorage vault | `~/.candlescan/cockpit/secrets.json` on your Mac |
| What it protects | Premium-tier broker access (Zerodha / Dhan via Worker proxy) for the deployed PWA | ntfy topic + (forward-looking) Dhan / Zerodha creds for the local cockpit |
| Crypto | RSA-OAEP-2048 (vault) + SHA-256 hash (passphrase) | none beyond Unix file permissions (mode 0600) |
| Configured via | [`scripts/rotate-keys.sh`](../scripts/rotate-keys.sh) → `npm run worker:rotate-keys` | the cockpit CLI (`npm run cockpit:init`, `cockpit:dhan`, etc.) |
| Required for the cockpit? | **No** — the cockpit talks to Yahoo + NSE directly, no Worker round-trip needed | n/a |

The cockpit does **not** call the PWA's gate-protected Worker endpoints
today. It talks to Yahoo and NSE directly from your Mac. So `worker:rotate-keys`
is unrelated to cockpit operation; it's only relevant if you also use
the deployed PWA's premium-tier broker integrations.

## Nomenclature

The system has a few names floating around in casual chat — they all
refer to the same thing:

| Term | What it actually is |
|---|---|
| **Cockpit** | The official name in this codebase. Refers to the whole local-Mac system: scan loop + exit monitor + HTTP server + web UI + management CLI. |
| Cockpit daemon | The `npm run cockpit:start` process — the long-running scan + exit monitor + HTTP server. |
| Cockpit UI | The dark-themed single-page web UI served at `cockpit.local:5174/`. |
| Autopilot / terminal mode | Informal aliases. Same thing. |

We use **Cockpit** consistently throughout the docs and code (file
paths, npm scripts, log lines). The other terms are just synonyms.

## Data source — Yahoo / Dhan / Zerodha

The cockpit's scan loop fetches OHLCV from one of three sources,
configured via `scan.dataSource` in `secrets.json`:

| Source | Status | Latency | Auth model | Notes |
|---|---|---|---|---|
| `yahoo` (default) | ✅ live | ~1 min delay | none | anonymous, no creds, fallback when broker unavailable |
| `dhan` | ✅ live | real-time | clientId + PIN stored, TOTP prompted at boot | needs `cockpit:dhan` first; needs an interactive TTY for the TOTP prompt at every boot |
| `zerodha` | ✅ live | real-time | apiKey + apiSecret + daily accessToken | needs `cockpit:zerodha` first; refresh token daily via `cockpit:zerodha -- access-token` |

Switch sources by editing `scan.dataSource` in `secrets.json` (or via
`cockpit:init` re-run). The cockpit talks to each broker's REST API
directly — **no Cloudflare Worker hop** — so dropping the worker out of
the cockpit's path entirely is intentional and shipped.

### Dhan boot flow

Configured Dhan + dataSource=dhan → at every cockpit boot:

1. Reads `dhan.clientId` + `dhan.pin` from secrets (decrypts via gate
   if set).
2. Prompts for the current 6-digit TOTP from your authenticator app.
3. Exchanges (clientId + pin + TOTP) for a 24-hour access token via
   `https://auth.dhan.co/app/generateAccessToken`.
4. Holds the access token in memory for the cockpit's lifetime —
   never written to disk.

If the cockpit is started non-interactively (`nohup`, anything without
a TTY) **and** `dataSource=dhan`, boot fails with a clear message.
The TOTP prompt requires interactive input at every boot.

### Zerodha boot flow

Configured Zerodha + dataSource=zerodha → at every cockpit boot:

1. Reads `zerodha.apiKey` + `zerodha.accessToken` from secrets
   (decrypts via gate if set).
2. Validates both are present, errors out cleanly if not.
3. Uses them on every Kite API call as `Authorization: token <key>:<token>`.

Zerodha access tokens expire daily (around 06:00 IST). Each morning,
generate a fresh one via the PWA Settings OAuth flow and paste it in:

```bash
npm run cockpit:zerodha -- access-token
```

### Instrument-map caching

Both brokers need a symbol → broker-id map for OHLCV calls (Kite uses
`instrument_token`, Dhan uses `securityId`). The cockpit caches these
maps to disk on first use:

| Broker | Cache file | TTL | Source |
|---|---|---|---|
| Zerodha | `~/.candlescan/cockpit/cache/zerodha-instruments.json` | 24h | `GET https://api.kite.trade/instruments/NSE` (~3 MB CSV) |
| Dhan | `~/.candlescan/cockpit/cache/dhan-instruments.json` | 7 days | `GET https://images.dhan.co/api-data/api-scrip-master.csv` (~32 MB) |

First boot on a fresh setup spends a few extra seconds downloading +
parsing. Subsequent boots load instantly from the cache.

## Configurable knobs (`secrets.json`)

| Path | Default | Purpose |
|---|---|---|
| `host.name` | `cockpit.local` | mDNS / LAN hostname put into notification URLs |
| `host.port` | `5174` | HTTP server port |
| `ntfy.topic` | — (required) | ntfy topic name; treat as a password |
| `ntfy.server` | `https://ntfy.sh` | swap to self-hosted ntfy by changing this |
| `scan.engine` | `intraday` | `scalp` / `intraday` / `delivery` |
| `scan.index` | `NIFTY 50` | any NSE index name your live PWA accepts |
| `scan.intervalSec` | `60` | scan tick frequency |
| `scan.minConfidence` | `75` | hide signals below this |
| `scan.timeframe` | `5m` | `1m` / `5m` / `15m` |
| `exit.intervalSec` | `30` | exit-monitor poll frequency |
| `scan.dataSource` | `yahoo` | `yahoo` / `dhan` / `zerodha` — only `yahoo` is wired today; Dhan/Zerodha live fetchers planned next |
| `dhan.clientId` | — | Dhan client ID (set via `cockpit:dhan`) |
| `dhan.pin` | — | Dhan PIN (file is mode 0600) |
| `zerodha.apiKey` | — | Zerodha API key |
| `zerodha.apiSecret` | — | Zerodha API secret |
| `zerodha.accessToken` | — | Zerodha daily access token |

## Files + data layout

```
~/.candlescan/cockpit/
  secrets.json                    # config (mode 0600); managed by CLI commands
  logs/<IST-date>.log             # plain-text log mirror, grep-friendly
  state/<IST-date>.json           # signals + paper trades, atomic writes
```

Source layout:

```
scripts/cockpit/
  index.mjs                       # entry: daemon (or dispatch to CLI if args)
  cli.mjs                         # CLI dispatcher with help text
  config.mjs                      # secrets loader + defaults + validation
  log.mjs                         # ANSI-colored categorized logger + file mirror
  notify.mjs                      # provider abstraction (ntfy primary)
  scan.mjs                        # scan loop body
  README.md                       # short stub pointing here
  ui/index.html                   # cockpit web UI (vanilla JS, dark theme)
  lib/
    yahoo.mjs                     # OHLCV fetcher
    symbols.mjs                   # NSE index symbols (cached per IST day)
    market-hours.mjs              # NSE market-state check
    holidays.mjs                  # NSE holiday calendar (2026 + 2027)
    state.mjs                     # flat-JSON state store
    server.mjs                    # Hono HTTP server + SSE event bus
    exit-monitor.mjs              # SL/target/EOD/trail logic
    prompts.mjs                   # readline + hidden-input helpers
    secrets-rw.mjs                # atomic secrets.json read/write
    pidfile.mjs                   # claim / release ~/.candlescan/cockpit/cockpit.pid
    gate.mjs                      # PBKDF2 + AES-GCM cred encryption
  commands/
    init.mjs config.mjs dhan.mjs zerodha.mjs
    gate.mjs rotate-topic.mjs status.mjs logs.mjs stop.mjs
```

## Trade flow walkthrough

1. Scan finds a high-conf signal → cockpit persists it (signal ID `sig_…`)
   → notification arrives on phone with two action buttons.
2. **Tap "Enter Paper Trade"** → action URL hits `/api/trades/enter?sig=…`
   → cockpit creates a paper trade with entry/SL/target from the signal,
   sized at Rs 1L (5x margin = Rs 5L exposure) → confirmation page.
3. Cockpit's exit monitor polls every 30s, fetches latest 1m bar per
   open trade, applies SL/target/EOD/breakeven-trail rules.
4. On exit → state updated, exit notification fires (with Open Cockpit /
   View Detail action buttons), P&L visible in cockpit UI's "Closed" tab.

### Manual force-exit

In the cockpit UI's "Open" tab, **Force Exit** prompts for an exit price and
closes the trade with reason `manual`. Useful for testing exit-monitor
edge cases or bailing out of a position the rules wouldn't catch.

## Known limitations + deferred polish

- **PWA standalone-window launch from notifications.** Body taps currently
  open the deployed PWA URL in your default browser. Workaround: reinstall
  the PWA via Chrome (it generates a WebAPK), then in Android Settings →
  Apps → CandleScan → "Open by default" → toggle "Always" for the
  candlescan URL pattern. Routes notification URLs to the WebAPK regardless
  of default browser. Or ship `.well-known/assetlinks.json` on GitHub Pages
  for universal auto-routing.
- **Layered scan context.** Live PWA's `batchScan` runs VIX / FII-DII / news
  / sector / index-direction / regime gate. Cockpit currently runs base
  patterns + risk only. Layering is incremental — the HIGH-VIX veto is the
  next addition.
- **Multi-tranche exits** for Trend Continuation Pullback. Currently exits
  at the first tranche target as single-leg; per-tranche partial exits TODO.
- **Confidence-tier sizing** per [tradeDecision.js][td]'s `DEFAULT_SIZE_TIERS`.
  Cockpit currently uses a flat Rs 1L base.
- **Encryption-at-rest of broker creds.** Today secrets.json relies on Unix
  file permissions (mode 0600). Once the cockpit's scan path actually
  consumes Dhan / Zerodha creds (Yahoo-only today), an at-rest encryption
  pass becomes worth adding. Earlier iteration shipped a PBKDF2 + AES-GCM
  gate command but it was removed because it was protecting unused fields
  and confused the "PWA gate" naming — see the table above.
- **NSE holiday calendar is hardcoded** for 2026 + 2027 in
  [holidays.mjs][hol]. Refresh annually from NSE's official list.

[td]: ../src/engine/tradeDecision.js
