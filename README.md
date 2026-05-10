# CandleScan

[![Deploy](https://github.com/utkarsh9891/candlescan/actions/workflows/deploy.yml/badge.svg)](https://github.com/utkarsh9891/candlescan/actions/workflows/deploy.yml)

NSE candlestick pattern scanner with risk scoring, batch index scans, simulation,
paper trading, and a Mac-side scan daemon. React 18 + Vite 6 PWA on GitHub
Pages, Cloudflare Worker proxy for broker APIs.

> **Educational only — not financial advice.**

**Live:** https://utkarsh9891.github.io/candlescan/

---

## Three runtimes

| Surface | Runs on | What it does |
|---|---|---|
| **PWA** | your phone / browser | mobile-first scanner: single-stock, batch index, simulation, paper trading, charts |
| **Cockpit** | your Mac (manual launch) | runs the scan loop + paper-trade exit monitor while your phone sleeps; pushes notifications via ntfy |
| **Worker** | Cloudflare edge | proxies Yahoo / Zerodha / Dhan / NSE for the PWA; handles gate auth |

The cockpit talks directly to brokers; it doesn't go through the Worker.

---

## Quick start

```bash
npm install
npm start              # Vite dev → http://127.0.0.1:5173/candlescan/
npm test               # 597 unit tests (vitest)
npm run build          # production build → dist/

# Demo mode (no network):
#   open  http://127.0.0.1:5173/candlescan/?simulate=1
```

Cockpit (Mac scan daemon, optional):

```bash
npm run cockpit:init   # interactive first-run setup
npm run cockpit:start        # start the daemon (manual; run when you want to)
npm run cockpit:stop   # gracefully stop the daemon
npm run cockpit:status # health check
npm run cockpit:help   # full CLI help
```

There's no auto-start — start the cockpit yourself each morning at whatever
time you want to begin scanning. Stop it with `cockpit:stop` (sends SIGTERM,
escalates to SIGKILL after 5s if it doesn't exit).

Full cockpit reference: [`docs/COCKPIT.md`](docs/COCKPIT.md).

---

## npm scripts

Grouped by domain. All sub-commands follow `<domain>:<verb>`. For a
quick reference on the command line:

```bash
npm run help        # categorized list with 1-line descriptions for every script
```

**Frontend / dev**

| Command | Purpose |
|---|---|
| `npm start` (alias `dev`) | Vite dev server |
| `npm run build` | production build → `dist/` |
| `npm run preview` | preview built `dist/` |

**Tests**

| Command | Purpose |
|---|---|
| `npm test` | run unit tests once (vitest) |
| `npm run test:watch` | watch mode |
| `npm run test:coverage` | with coverage report |

**Simulation**

| Command | Purpose |
|---|---|
| `npm run simulate` | CLI bar-by-bar trading simulation |

**Cockpit (Mac scan daemon)**

| Command | Purpose |
|---|---|
| `npm run cockpit:start` | start the daemon |
| `npm run cockpit:stop` | stop the daemon (SIGTERM, escalates to SIGKILL) |
| `npm run cockpit:status` | health summary (secrets / daemon / today's P&L) |
| `npm run cockpit:init` | interactive first-run setup wizard |
| `npm run cockpit:config` | print effective config (redacted; `-- --show-secrets` to reveal) |
| `npm run cockpit:logs` | print or follow today's cockpit log |
| `npm run cockpit:help` | top-level help; `-- <cmd>` for any subcommand |
| `npm run cockpit:dhan` | manage Dhan broker creds |
| `npm run cockpit:zerodha` | manage Zerodha Kite creds |
| `npm run cockpit:gate` | optional passphrase that encrypts secrets.json fields at rest |
| `npm run cockpit:rotate-topic` | rotate ntfy push topic locally (no remote notify) |

**Local chart cache**

| Command | Purpose |
|---|---|
| `npm run cache:warm` | quick warm of recent OHLCV (no date range — uses Yahoo's per-timeframe max retention) |
| `npm run cache:backfill` | explicit date-range backfill (e.g. `-- --from 2026-04-01 --to 2026-04-30`) |
| `npm run cache:sync` | warm + commit + push to the `candlescan-cache` sibling repo |

**Cloudflare Worker ops**

| Command | Purpose |
|---|---|
| `npm run worker:rotate-keys` | rotate Worker RSA keys + gate passphrase hash |
| `npm run worker:audit-kv` | audit `CANDLESCAN_*` KV namespaces (`-- --clean` to delete stale) |

CLI docs: pass `--help` to any command, e.g. `npm run cockpit:help -- dhan`.

---

## Documentation

The main README stays slim. Detail lives in `docs/`:

| Topic | File |
|---|---|
| Cockpit (daemon, CLI, ntfy, paper trades) | [`docs/COCKPIT.md`](docs/COCKPIT.md) |
| Secrets — where every key, hash, token lives | [`docs/SECRETS.md`](docs/SECRETS.md) |
| Architecture / engine internals / data flow | [`docs/AGENTS.md`](docs/AGENTS.md) |
| External integrations (Yahoo / Zerodha / Dhan / NSE / Worker) | [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) |
| Cloudflare Worker ops | [`docs/WORKER_OPS.md`](docs/WORKER_OPS.md) |
| CLI simulation walkthrough | [`docs/SIMULATE.md`](docs/SIMULATE.md) |
| Branching, merge, tag, release rules | [`docs/GIT_WORKFLOW.md`](docs/GIT_WORKFLOW.md) |
| Zerodha credential setup (PWA-side) | [`docs/ZERODHA_SETUP.md`](docs/ZERODHA_SETUP.md) |

Repo-wide rules and project identity live in [`CLAUDE.md`](CLAUDE.md).

---

## Tech stack

React 18 (hooks, no Redux) · Vite 6 · custom SVG charts (no Chart.js / D3) ·
plain JSX (no TypeScript) · inline styles (no CSS files) · Vitest 4 · PWA via
`vite-plugin-pwa` · Hono on Node for the cockpit HTTP server · Cloudflare
Workers (Wrangler) for the proxy.

---

## Versioning + license

CI auto-tags every merge to `main`. Default is **patch**; apply
`release:minor` or `release:major` label on the PR **before merging** to bump
higher. `package.json` has no `version` field — it comes from
`git describe --tags` at build time. Full rules:
[`docs/GIT_WORKFLOW.md`](docs/GIT_WORKFLOW.md).

MIT — see [`LICENSE`](LICENSE).
