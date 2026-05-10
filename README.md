# CandleScan

[![Deploy](https://github.com/utkarsh9891/candlescan/actions/workflows/deploy.yml/badge.svg)](https://github.com/utkarsh9891/candlescan/actions/workflows/deploy.yml)

NSE candlestick pattern scanner with risk scoring, batch index scans, simulation,
paper trading, and a Mac-side scan daemon. React 18 + Vite 6 PWA on GitHub
Pages, Cloudflare Worker proxy for broker APIs.

> **Educational only — not financial advice.**

**Live**: https://utkarsh9891.github.io/candlescan/

## What's here

| Surface | Where it lives | What it does |
|---|---|---|
| **PWA** | live URL above | mobile-first scanner: single-stock, batch index, simulation, paper trading, charts |
| **Cockpit** | Mac-side daemon | runs scans + paper-trade exit monitor while your phone sleeps; pushes notifications via ntfy |
| **Worker** | Cloudflare | proxies Yahoo / Zerodha / Dhan / NSE; quote / news; gate auth for premium |
| **CLI** | `scripts/` | simulation, walk-forward, cache warming, replay-reference-trades |

## Quick start

```bash
npm install
npm start            # Vite dev → http://127.0.0.1:5173/candlescan/
npm test             # 597 unit tests (vitest)
npm run build        # production build → dist/
```

Demo mode (no network):

```bash
npm start
# open http://127.0.0.1:5173/candlescan/?simulate=1
```

Cockpit (Mac scan daemon, optional):

```bash
npm run cockpit:init   # interactive first-run setup
npm run cockpit        # start the daemon
npm run cockpit:status # health check
npm run cockpit:help   # all commands
```

Full cockpit docs: [`docs/COCKPIT.md`](docs/COCKPIT.md).

## npm scripts (high-level)

| Command | Purpose |
|---|---|
| `npm start` | Vite dev server |
| `npm test` | unit tests (vitest) |
| `npm run build` | production build → `dist/` |
| `npm run pages` | manual deploy to GitHub Pages (CI runs this on merge) |
| `npm run simulate` | CLI bar-by-bar trading simulation |
| `npm run cache:warm` | warm the chart cache for a date range |
| `npm run cache:sync` | warm + commit + push to candlescan-cache repo |
| `npm run cockpit` | start the Mac-side cockpit daemon |
| `npm run cockpit:init` | interactive first-run setup wizard |
| `npm run cockpit:dhan` | configure Dhan broker creds (CLI) |
| `npm run cockpit:zerodha` | configure Zerodha broker creds (CLI) |
| `npm run cockpit:rotate-topic` | rotate the ntfy push topic locally (no remote notify) |
| `npm run cockpit:status` | cockpit health summary |
| `npm run cockpit:logs` | print/follow today's cockpit log |
| `npm run cockpit:help` | full CLI help |
| `npm run keys:rotate` | rotate CF Worker RSA keys + gate passphrase hash (PWA premium gate) |
| `npm run kv:audit` | audit `CANDLESCAN_KV` namespace (active vs stale keys; `--clean` to delete stale) |

CLI docs: see `--help` on any command, e.g. `npm run cockpit:help -- dhan`.

## Documentation

The main README stays slim. Detail lives in `docs/`:

| Topic | File |
|---|---|
| Cockpit (daemon, CLI, ntfy, paper trades) | [`docs/COCKPIT.md`](docs/COCKPIT.md) |
| Architecture / engine internals / data flow | [`docs/AGENTS.md`](docs/AGENTS.md) |
| External integrations (Yahoo / Zerodha / Dhan / NSE / Worker) | [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) |
| Cloudflare Worker ops | [`docs/WORKER_OPS.md`](docs/WORKER_OPS.md) |
| CLI simulation walkthrough | [`docs/SIMULATE.md`](docs/SIMULATE.md) |
| Branching, merge, tag, release rules | [`docs/GIT_WORKFLOW.md`](docs/GIT_WORKFLOW.md) |
| Zerodha credential setup (PWA-side) | [`docs/ZERODHA_SETUP.md`](docs/ZERODHA_SETUP.md) |

Repo-wide rules and project identity live in [`CLAUDE.md`](CLAUDE.md).

## Tech stack

React 18 (hooks, no Redux) · Vite 6 · custom SVG charts (no Chart.js / D3) ·
plain JSX (no TypeScript) · inline styles (no CSS files) · Vitest 4 · PWA
via `vite-plugin-pwa` · Hono on Node for the cockpit HTTP server ·
Cloudflare Workers (Wrangler) for the proxy.

## Versioning

CI auto-tags every merge to `main`. Default is **patch**; apply
`release:minor` or `release:major` label on the PR **before merging** to
bump higher. `package.json` has no `version` field — it comes from
`git describe --tags` at build time. Full rules: [`docs/GIT_WORKFLOW.md`](docs/GIT_WORKFLOW.md).

## License

MIT — see [`LICENSE`](LICENSE).
