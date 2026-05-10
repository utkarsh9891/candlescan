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
  - [`cockpit` (daemon)](#cockpit-daemon)
  - [`cockpit:init`](#cockpitinit)
  - [`cockpit:status`](#cockpitstatus)
  - [`cockpit:config`](#cockpitconfig)
  - [`cockpit:dhan`](#cockpitdhan)
  - [`cockpit:zerodha`](#cockpitzerodha)
  - [`cockpit:gate`](#cockpitgate)
  - [`cockpit:rotate-topic`](#cockpitrotate-topic)
  - [`cockpit:logs`](#cockpitlogs)
  - [`cockpit:help`](#cockpithelp)
- [Auto-start at 09:08 IST (launchd)](#auto-start-at-0908-ist-launchd)
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

# 4. (optional, but nice-to-have for security) Set a passphrase that
#    encrypts broker creds at rest in secrets.json.
npm run cockpit:gate set

# 5. (optional) Configure broker creds for live data.
npm run cockpit:dhan
npm run cockpit:zerodha

# 6. Start the daemon.
npm run cockpit

# 7. (optional) Auto-start every weekday at 09:08 IST.
bash scripts/cockpit/launchd/install.sh
```

After step 6 you should see:

- **Terminal**: colored `BOOT` lines + a `NOTIFY` line + per-tick `SCAN`
  lines + per-signal `SIGNAL ★` lines.
- **Phone**: a "Cockpit started" notification, then one notification per
  high-conf signal (with two action buttons: Enter Paper Trade, View Detail).
- **Cockpit UI**: open `http://cockpit.local:5174/` from any device on the
  same network. Live signals, open positions, closed P&L, SSE-powered
  live event stream.

After step 7 the launchd job fires automatically every weekday morning
without manual intervention. Holidays are handled by [holidays.mjs][hol].

[hol]: ../scripts/cockpit/lib/holidays.mjs

### PWA setting

In the deployed PWA → Settings → **Cockpit (optional)** card, paste your
cockpit URL (e.g. `http://cockpit.local:5174`) and tap Save. Each device
stores its own value in `localStorage` under `candlescan_cockpit_url`, so
multiple users / devices can point at their own cockpits without colliding.

## CLI reference

Every command supports `--help` (or `-h`); the dispatcher also takes
`npm run cockpit:help <command>` for the same.

### `cockpit` (daemon)

```bash
npm run cockpit
```

Starts the daemon. Boots all three loops (scan / exit-monitor / HTTP).
If a [gate](#cockpitgate) is set, prompts for the passphrase. If the
process is started non-interactively (e.g. via launchd) **and** a gate
is set, it errors out with a clear message — gates require a TTY.

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
- Is the launchd job loaded?
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
npm run cockpit:dhan -- show            # show stored fields (redacted)
npm run cockpit:dhan -- clear           # remove all Dhan creds
npm run cockpit:dhan -- --help          # full help
```

Stores: clientId, partnerId (optional), pin (hidden, encrypted if
[gate](#cockpitgate) is set). **TOTP is not stored** — when the daemon
launches and detects Dhan is configured, it prompts for the current TOTP
interactively, exchanges (clientId + pin + TOTP) for a 24-hour access
token via the Dhan auth endpoint, and holds the token in memory for the
session. This is why a Dhan-configured cockpit cannot fully auto-start
via launchd today (no TTY for TOTP).

### `cockpit:zerodha`

```bash
npm run cockpit:zerodha                       # set apiKey + apiSecret + accessToken
npm run cockpit:zerodha -- access-token       # rotate ONLY the daily access token
npm run cockpit:zerodha -- show               # show stored fields (redacted)
npm run cockpit:zerodha -- clear              # remove all Zerodha creds
npm run cockpit:zerodha -- --help             # full help
```

Zerodha access tokens expire daily around 06:00 IST. Use `access-token`
each morning rather than re-running the full setup. If a [gate](#cockpitgate)
is set, `apiSecret` and `accessToken` are encrypted at rest.

### `cockpit:gate`

```bash
npm run cockpit:gate                          # show status (default)
npm run cockpit:gate -- set                   # set / change passphrase
npm run cockpit:gate -- clear                 # remove gate (decrypts)
npm run cockpit:gate -- test                  # verify a passphrase
npm run cockpit:gate -- --help                # full help
```

Optional passphrase that encrypts Dhan PIN + Zerodha apiSecret/accessToken
in `secrets.json`. Crypto: PBKDF2-SHA256 (200k iter) → AES-256-GCM (12-byte
IV, embedded auth tag). Once set, the daemon prompts at startup. **Launchd
auto-start does not work while a gate is set** — pick one or the other.

### `cockpit:rotate-topic`

```bash
npm run cockpit:rotate-topic
```

Generates a new random ntfy topic, sends a notification to the **old** topic
announcing the new name (so your phone's ntfy app gets the message), then
updates `secrets.json`. After running:

1. Subscribe to the new topic in the ntfy app on your phone.
2. Unsubscribe from the old.
3. Update your password manager.
4. Restart the daemon.

Cheap and clean — rotate any time you suspect a topic leak.

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

## Auto-start at 09:08 IST (launchd)

```bash
bash scripts/cockpit/launchd/install.sh
```

This:

- Renders [com.candlescan.cockpit.plist][plist] with your username + repo
  path + Node path.
- Loads it via `launchctl bootstrap`.
- Schedules `pmset wake-from-sleep` at 09:06 IST weekdays so the Mac wakes
  before the launchd job fires (requires AC power; laptops on battery
  should set Energy Saver "prevent sleep" during market hours instead).

To uninstall:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.candlescan.cockpit.plist
rm ~/Library/LaunchAgents/com.candlescan.cockpit.plist
sudo pmset repeat cancel
```

[plist]: ../scripts/cockpit/launchd/com.candlescan.cockpit.plist

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
| `dhan.clientId` | — | Dhan client ID (set via `cockpit:dhan`) |
| `dhan.pin` | — | Dhan PIN (encrypted if gate is set) |
| `zerodha.apiKey` | — | Zerodha API key |
| `zerodha.apiSecret` | — | Zerodha API secret (encrypted if gate is set) |
| `zerodha.accessToken` | — | Zerodha daily access token (encrypted if gate is set) |
| `gate.salt`, `gate.verifier` | — | gate config (set via `cockpit:gate`) |

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
  config.mjs                      # secrets loader + interactive gate decrypt
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
    gate.mjs                      # PBKDF2 + AES-GCM encryption
  commands/
    init.mjs config.mjs dhan.mjs zerodha.mjs gate.mjs
    rotate-topic.mjs status.mjs logs.mjs
  launchd/
    com.candlescan.cockpit.plist  # template
    install.sh                    # rendering + bootstrap script
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
- **Gate + launchd are mutually exclusive.** Gates require an interactive
  TTY for the passphrase prompt; launchd has no TTY. Future work: keychain
  integration so the gate key can be unlocked non-interactively.
- **NSE holiday calendar is hardcoded** for 2026 + 2027 in
  [holidays.mjs][hol]. Refresh annually from NSE's official list.

[td]: ../src/engine/tradeDecision.js
