# CandleScan

Mobile-first NSE candlestick pattern scanner with liquidity box analysis, risk scoring (0-100), and batch index scanning. Built with React 18 + Vite 6, deployed as a PWA to GitHub Pages.

**Educational only — not financial advice.**

**Live:** https://utkarsh9891.github.io/candlescan/

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
| Index data | NSE India equity-stockIndices API |
| CORS proxy | Cloudflare Worker (production) |
| PWA | vite-plugin-pwa (Workbox) |
| Deploy | GitHub Actions → GitHub Pages |
| Auth | SHA-256 passphrase via Cloudflare Worker |
| Rate limit | Cloudflare KV (20 req/day per IP) |

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
│   │   ├── GlobalMenu.jsx       # Hamburger menu: signal filters + page nav
│   │   ├── Header.jsx           # Brand, status badge, mode toggle
│   │   ├── SearchBar.jsx        # Symbol input + index button + scan
│   │   ├── TimeframePills.jsx   # 1m/5m/15m/30m/1h/1d selector
│   │   ├── DrawingToolbar.jsx   # H-Line, Box, Clear
│   │   ├── IndexConstituentsSidebar.jsx  # Slide-out stock list
│   │   ├── RiskRing.jsx         # Circular confidence gauge
│   │   ├── RiskScoreSignals.jsx # 5-component breakdown display
│   │   ├── EmptyState.jsx       # Placeholder before first scan
│   │   └── SignalFilters.jsx    # Category filter dropdown
│   ├── engine/
│   │   ├── fetcher.js           # Yahoo Finance fetch + fallback chain
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
│   │   ├── signalCategories.js  # Category labels + rule counts
│   │   └── niftyStocks.js       # Deprecated stub
│   └── utils/
│       └── batchAuth.js         # Passphrase localStorage helpers
├── worker/
│   ├── index.js                 # Cloudflare Worker: CORS proxy + auth + rate limiting
│   ├── wrangler.toml            # Worker config + KV binding
│   └── OPS.md                   # Operations guide (passphrase reset, deploy)
├── scripts/
│   ├── start.sh                 # Dev server wrapper
│   ├── deploy-to-pages.sh       # Legacy manual deploy
│   ├── batch-test.mjs           # CLI batch scanner
│   ├── warm-chart-cache.mjs     # Pre-warm chart cache
│   └── lib/
│       ├── chart-cache-fs.mjs   # Disk-based chart cache read/write
│       └── nse-http.mjs         # NSE HTTP helpers for Node
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
    → Try: Vite proxy → CF Worker → Jina Reader → allorigins
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
  → batchScan({symbols, timeframe, batchToken})
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

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Blank page on Pages | Check `base: '/candlescan/'` in vite.config.js |
| No chart data on Pages | Try different network; CORS proxies may be blocked |
| `npm start` fails | Run `npm install` first |
| Batch scan 403 | Wrong passphrase — see [worker/OPS.md](worker/OPS.md) |
| Batch scan 429 | Rate limited (20/day per IP); use passphrase to bypass |
| Demo data not showing | `?simulate=1` only works in dev, not production |
| Browse stocks empty | Redeploy CF Worker with NSE allowlist; or NSE is down |

---

## License

See [LICENSE](LICENSE) in this repository.
