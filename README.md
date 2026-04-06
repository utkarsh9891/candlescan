# CandleScan

[![Deploy](https://github.com/utkarsh9891/candlescan/actions/workflows/deploy.yml/badge.svg)](https://github.com/utkarsh9891/candlescan/actions/workflows/deploy.yml)

Mobile-first NSE candlestick pattern scanner with liquidity box analysis, risk scoring (0-100), and batch index scanning. Built with React 18 + Vite 6, deployed as a PWA to GitHub Pages.

**Educational only — not financial advice.**

**Live:** https://utkarsh9891.github.io/candlescan/

---

## Table of Contents
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Quick Start](#quick-start)
- [npm Scripts](#npm-scripts)
- [Project Structure](#project-structure)
- [Data Flow](#data-flow)
- [Environment Differences](#environment-differences)
- [Deployment](#deployment)
- [Local Chart Cache](#local-chart-cache)
- [Testing](#testing)
- [Versioning](#versioning)
- [Debug Mode](#debug-mode)
- [Gate Auth Flow](#gate-auth-flow)
- [Rate Limiting](#rate-limiting)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Features

### Single Stock Scanner
- Enter any NSE symbol (e.g. RELIANCE, TCS, HDFCBANK)
- 6 timeframes: 1m, 5m, 15m, 30m, 1h, 1d
- **Pattern detection**: 8 categories, ~46 rules (engulfing, hammer, reversal, pullback, liquidity, momentum, indecision, piercing)
- **Liquidity box**: Consolidation zone detection with breakout/trap analysis
- **Risk score**: 0-100 confidence with trade action (STRONG BUY / BUY / WAIT / SHORT / STRONG SHORT / NO TRADE)
- **Trade levels**: Entry, Stop Loss, Target, Risk:Reward ratio
- **Context**: Support / Resistance / Breakout / Mid-Range detection

### Interactive Chart
- Custom SVG candlestick renderer (no external charting library)
- Zoom (ctrl+wheel / pinch), pan (scroll/swipe), crosshair
- Drawing tools: horizontal lines (draggable) and boxes (directional +/- display)
- Pattern highlight overlay (toggleable)
- Liquidity box overlay with manipulation zones

### Batch Index Scanner
- Scan all stocks in an NSE index (NIFTY 50 to NIFTY 500)
- Results sorted by signal strength (STRONG BUY/SHORT first)
- Filter by actionable/all and by direction (Buy/Short)
- Search within results
- Tap any result to drill into single-stock analysis
- Background persistence — scan continues while you browse individual stocks
- Auth-gated: passphrase required (see [Worker OPS](worker/OPS.md))

### PWA (Progressive Web App)
- Install on Android via Chrome "Add to Home Screen"
- Standalone mode (no browser chrome)
- Service worker caches app shell for fast loads
- **Auto-update**: When a new version is deployed, the service worker detects the change and updates automatically on next visit (Workbox `autoUpdate` strategy)

### Custom Indices
- Add any NSE index via hamburger menu → "Custom Indices" section
- Validates against live NSE API before adding
- Persists in localStorage, appears in all dropdowns with "(custom)" label
- Remove via minus button in the menu

### Two View Modes
- **Simple**: Compact decision card — price, action, score ring, top patterns, entry/SL/target
- **Advanced**: Adds bid/ask quote, exit timer, full score breakdown, R:R display

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| UI | React 18 (hooks, no Redux) |
| Build | Vite 6 |
| Chart | Custom SVG (no D3/Chart.js) |
| Data | Yahoo Finance v8 chart API |
| Data (alt) | Zerodha Kite Connect API (optional, premium) |
| Index data | NSE India equity-stockIndices API |
| CORS proxy | Cloudflare Worker (production) |
| PWA | vite-plugin-pwa (Workbox) |
| Deploy | GitHub Actions → GitHub Pages |
| Auth | RSA + SHA-256 gate auth via Cloudflare Worker |
| Rate limit | Cloudflare KV (20 req/day free tier, unlimited premium) |

**Runtime dependencies**: React + React DOM only. Everything else is custom code.

---

## Quick Start

```bash
git clone https://github.com/utkarsh9891/candlescan.git
cd candlescan
npm install
npm start
```

Open http://127.0.0.1:5173/candlescan/

### Demo mode (no network needed)
```bash
# Generates simulated candle data for testing
# Add ?simulate=1 to the URL after starting
npm start
# → http://127.0.0.1:5173/candlescan/?simulate=1
```

---

## npm Scripts

| Script | Purpose |
|--------|---------|
| `npm start` / `npm run dev` | Vite dev server at `127.0.0.1:5173` with Yahoo + NSE proxy |
| `npm test` | Run all unit tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run build` | Production build → `dist/` (base: `/candlescan/`) |
| `npm run preview` | Serve built `dist/` locally (no dev proxy, uses CORS fallbacks) |
| `npm run pages` | Build + copy to sibling `../utkarsh9891.github.io/candlescan/` (legacy) |
| `npm run test:batch` | Node script: scan NSE index using `cache/charts/` |
| `npm run cache:charts` | Warm local chart cache from Yahoo for all index symbols |

---

## Project Structure

```
candlescan/
├── index.html                    # Vite entry + PWA meta tags
├── vite.config.js               # Build config, dev proxies, PWA plugin
├── vite-plugin-chart-cache.mjs  # Dev-only chart cache middleware
├── package.json                 # React 18, Vite 6, vite-plugin-pwa
├── public/
│   └── icons/                   # PWA icons (192x192, 512x512 SVG)
├── src/
│   ├── main.jsx                 # React root
│   ├── App.jsx                  # Root component: all state, scan logic, view routing
│   ├── components/
│   │   ├── Chart.jsx            # SVG chart: candles, zoom, pan, crosshair, drawings
│   │   ├── SimpleView.jsx       # Compact result card (price, action, score ring)
│   │   ├── AdvancedView.jsx     # Extended view (quote, timer, breakdown)
│   │   ├── BatchScanPage.jsx    # Index scanner: progress, results, filters
│   │   ├── SettingsPage.jsx     # Premium gate, data source, Zerodha credential management
│   │   ├── GlobalMenu.jsx       # Hamburger menu: signal filters + page nav
│   │   ├── Header.jsx           # Brand, status badge, mode toggle
│   │   ├── SearchBar.jsx        # Symbol input + index button + scan
│   │   ├── TimeframePills.jsx   # 1m/5m/15m/30m/1h/1d selector
│   │   ├── DrawingToolbar.jsx   # H-Line, Box, Clear
│   │   ├── IndexConstituentsSidebar.jsx  # Slide-out stock list
│   │   ├── RiskRing.jsx         # Circular confidence gauge
│   │   ├── RiskScoreSignals.jsx # 5-component breakdown display
│   │   └── EmptyState.jsx       # Placeholder before first scan
│   ├── engine/
│   │   ├── fetcher.js           # Yahoo Finance fetch + fallback chain
│   │   ├── zerodhaFetcher.js    # Zerodha Kite Connect API fetcher
│   │   ├── patterns.js          # 46-rule pattern detection (8 categories)
│   │   ├── liquidityBox.js      # Consolidation box + breakout/trap
│   │   ├── risk.js              # 5-component risk scoring (0-100)
│   │   ├── batchScan.js         # Throttled multi-stock scanner
│   │   ├── nseIndexFetch.js     # NSE index constituent fetcher
│   │   ├── nseIndexParse.js     # NSE JSON parser
│   │   └── yahooQuote.js        # Yahoo v7 quote (bid/ask)
│   ├── config/
│   │   └── nseIndices.js        # Index list + defaults
│   ├── data/
│   │   └── signalCategories.js  # Category labels + rule counts
│   └── utils/
│       ├── batchAuth.js         # Gate auth — passphrase hashing + localStorage helpers
│       └── credentialVault.js   # RSA credential encryption + vault storage
├── worker/
│   ├── index.js                 # Cloudflare Worker: CORS proxy + auth + rate limiting
│   ├── wrangler.toml            # Worker config + KV binding
│   └── OPS.md                   # Operations guide (passphrase reset, deploy)
├── scripts/
│   ├── start.sh                 # Dev server wrapper
│   ├── deploy-to-pages.sh       # Legacy manual deploy
│   ├── simulate-day.mjs         # CLI trading simulation
│   ├── warm-chart-cache.mjs     # Pre-warm chart cache
│   ├── rotate-keys.sh           # RSA key pair generation + CF Worker deployment
│   └── lib/
│       ├── chart-cache-fs.mjs   # Disk-based chart cache read/write
│       └── nse-http.mjs         # NSE HTTP helpers for Node
├── docs/
│   └── ZERODHA_SETUP.md         # Zerodha integration setup guide
├── cache/
│   └── charts/                  # Local chart JSON cache (gitignored)
└── .github/
    └── workflows/deploy.yml     # Auto-deploy to Pages on push to main
```

---

## Data Flow

### Single Stock Scan
```
User enters symbol
  → normalizeSymbol() (RELIANCE → RELIANCE.NS, NIFTY50 → ^NSEI)
  → fetchOHLCV(symbol, timeframe)
    → If Zerodha configured: try Zerodha Kite API via CF Worker
    → Fallback: Vite proxy → CF Worker → Jina Reader → allorigins
    → Parse Yahoo v8 JSON → trim trailing flat candles
  → detectPatterns(candles)        # 46 rules, 8 categories
  → detectLiquidityBox(candles)    # consolidation zone detection
  → computeRiskScore({candles, patterns, box})
    → 5 components: signal clarity + noise + R:R + reliability + confluence
    → Action: STRONG BUY/SHORT (≥72), BUY/SHORT (≥58), WAIT (≥50), NO TRADE
  → Render: Chart + SimpleView/AdvancedView
```

### Batch Index Scan
```
User selects index + timeframe → Scan All
  → fetchNseIndexSymbolList(index)  # NSE API → symbol list
  → batchScan({symbols, timeframe, gateToken})
    → 5 concurrent fetches, 200ms delay between batches
    → Per stock: fetchOHLCV → patterns → box → risk
  → Sort by action rank + confidence
  → Display result cards (filterable, searchable, tappable)
```

---

## Environment Differences

| Feature | Dev (`npm start`) | Production (Pages) |
|---------|-------------------|-------------------|
| Yahoo data | Vite proxy (same-origin) | CF Worker + fallback chain |
| NSE data | Vite proxy | CF Worker + allorigins |
| Chart cache | Local disk (`cache/charts/`) | None (network only) |
| Demo data | `?simulate=1` available | Disabled |
| Service worker | Registered | Auto-update on deploy |
| CORS | No issues | Proxied via CF Worker |

---

## Deployment

### Automatic (recommended)
Push to `main` triggers GitHub Actions:
1. `npm ci` + `npm run build`
2. Deploy `dist/` to GitHub Pages
3. Live at https://utkarsh9891.github.io/candlescan/

**Setup (one-time):** Repo Settings → Pages → Source: "GitHub Actions"

### Cloudflare Worker
See [worker/OPS.md](worker/OPS.md) for full deployment and passphrase management guide.

```bash
cd worker
npx wrangler deploy
```

---

## Local Chart Cache

Dev-only disk cache at `cache/charts/`. See [cache/charts/README.md](cache/charts/README.md).

- Auto-populated on first fetch in dev
- 7-day TTL (configurable via `CANDLESCAN_CHART_CACHE_MAX_AGE_MS`)
- Disable: `CANDLESCAN_CHART_CACHE=0 npm start`
- Warm all: `npm run cache:charts`

---

## Testing

### Unit Tests (Vitest)
```bash
npm test          # Run all tests once
npm run test:watch  # Watch mode (re-runs on file change)
```

**47 tests** across 6 test files covering:
- `src/engine/patterns.test.js` — pattern detection (bullish/bearish engulfing, hammer, edge cases)
- `src/engine/risk.test.js` — risk scoring (confidence range, direction, action labels, context detection)
- `src/engine/liquidityBox.test.js` — box detection (consolidation, breakout, empty input)
- `src/engine/fetcher.test.js` — utility functions (trimTrailingFlatCandles, timeframe map)
- `src/config/nseIndices.test.js` — custom index add/remove/dedup/merge
- `src/utils/batchAuth.test.js` — token get/set/clear/has

Test fixtures at `src/engine/__fixtures__/candles.js` — reusable candle data sets.

### Pre-push Hook
Tests + build run automatically before every `git push`. If either fails, the push is blocked.
- Auto-configured via `npm install` (uses `.git-hooks/pre-push`)
- Bypass in emergencies: `git push --no-verify`

### CI Pipeline
GitHub Actions runs on every push to `main`:
1. `npm ci` — clean install
2. `npm test` — all unit tests must pass
3. `npm run build` — production build
4. **Smoke check** — verifies `dist/index.html` exists and contains "CandleScan"
5. Deploy to GitHub Pages

If tests or build fail, deployment is blocked.

---

## Versioning

**Pre-1.0** — this project is in active development. Version `v0.x.y` signals the app is not yet production-ready.

Version is derived from **git tags** at build time — no hardcoding required. CI auto-increments the patch number on every merge to `main`.

```bash
# After each merge to main, CI auto-tags:
#   v0.5.0 → v0.5.1 → v0.5.2 → ...

# Manual minor bump (milestone):
git tag v0.6.0
git push origin v0.6.0
```

- **Source**: `git describe --tags --always` (run at build time in `vite.config.js`)
- **Display**: hamburger menu bottom — e.g. `v0.5.3-2-gabcdef 31 Mar`
- **CI**: GitHub Actions fetches full git history (`fetch-depth: 0`) so tags are available
- **Full guide**: See [`GIT_WORKFLOW.md`](GIT_WORKFLOW.md)

## Debug Mode

In-app API call inspector — toggle via hamburger menu → "Debug mode" checkbox.

When enabled:
- Bottom panel shows all `fetch()` calls in real-time
- Each entry: timestamp, HTTP status (color-coded), response time, URL
- Key icon indicates requests with gate token
- Shows CF Worker proxy destinations (chart data, NSE index, quotes)
- "Clear" button to reset log
- Last 50 requests retained

Use to verify: gate token is being sent, requests aren't 429/403, response times are reasonable.

---

## Gate Auth Flow

1. User enters passphrase → SHA-256 hash stored in localStorage (`candlescan_gate_hash`)
2. POST /gate/unlock with hash → CF Worker validates → returns RSA public key
3. Zerodha credentials encrypted with RSA public key → stored in localStorage
4. API requests send `X-Gate-Token` header + encrypted vault blob
5. CF Worker decrypts vault with RSA private key → proxies to Kite API

Environment variable on the CF Worker: `GATE_PASSPHRASE_HASH` (see [worker/OPS.md](worker/OPS.md)).

---

## Rate Limiting

- **Free tier**: 20 req/day per IP, batch scan disabled
- **Premium** (valid gate token): unlimited, batch scan + Zerodha enabled

Rate limits are enforced via Cloudflare KV. See [worker/OPS.md](worker/OPS.md) for configuration.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Blank page on Pages | Check `base: '/candlescan/'` in vite.config.js |
| No chart data on Pages | Try different network; CORS proxies may be blocked |
| `npm start` fails | Run `npm install` first |
| Gate auth 403 | Wrong passphrase — see [worker/OPS.md](worker/OPS.md) |
| Rate limited | 20/day per IP; unlock premium for unlimited |
| Zerodha 401 | Access token expired — re-enter in Settings |
| Vault decrypt error | Keys rotated — re-enter credentials in Settings |
| Demo data not showing | `?simulate=1` only works in dev, not production |
| Browse stocks empty | Redeploy CF Worker with NSE allowlist; or NSE is down |

---

## License

See [LICENSE](LICENSE) in this repository.
