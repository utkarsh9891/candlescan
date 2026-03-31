# AGENTS.md — Coding Agent Guide for CandleScan

> This file helps AI coding agents (Claude, Cursor, Copilot, Aider, etc.) understand the project quickly and make correct changes.

## What is this project?
CandleScan is a React 18 + Vite 6 mobile-first PWA for NSE (National Stock Exchange of India) candlestick pattern detection, liquidity box analysis, and risk scoring (0-100). It fetches OHLCV data from Yahoo Finance, renders interactive SVG charts, and includes a batch index scanner with auth-gated access.

## Quick commands
```bash
npm install          # Install dependencies
npm start            # Dev server at http://127.0.0.1:5173/candlescan/
npm run build        # Production build → dist/
npm run preview      # Serve built files locally (no dev proxy)
npm run test:batch   # CLI batch scan using cache/charts/
npm run cache:charts # Pre-warm chart cache from Yahoo
```

## Dev server with simulated data (no network needed)
```bash
npm start
# Open http://127.0.0.1:5173/candlescan/?simulate=1
```
Only works when `import.meta.env.DEV === true`. Production builds ignore this flag.

---

## Architecture

- **Framework**: React 18, Vite 6, no external charting library
- **Entry**: `src/main.jsx` → `src/App.jsx`
- **State management**: React useState/useEffect only (no Redux/Context)
- **Chart**: Custom SVG in `src/components/Chart.jsx` (zoom, pan, crosshair, drawings)
- **Analysis engine**: `src/engine/` — fetcher, patterns (46 rules), liquidityBox, risk (5-component scoring)
- **Batch scanner**: `src/engine/batchScan.js` — throttled multi-stock scan with concurrency control
- **PWA**: `vite-plugin-pwa` with Workbox `autoUpdate` — service worker + manifest
- **Deployment**: GitHub Actions → GitHub Pages at `utkarsh9891.github.io/candlescan/`
- **CORS proxy**: Cloudflare Worker at `worker/` for Yahoo Finance + NSE India `/api/*`
- **Auth**: SHA-256 passphrase validation at Worker level; `src/utils/batchAuth.js` for localStorage
- **Rate limiting**: Cloudflare KV — 20 req/day per IP (unauthenticated); batch token bypasses
- **Index constituents**: NSE `equity-stockIndices` at runtime; dev uses Vite proxy; prod uses CF Worker
- **Local chart cache**: `cache/charts/` (gitignored) — `vite-plugin-chart-cache.mjs` serves from disk in dev

---

## Key Files

| File | Purpose |
|------|---------|
| `src/App.jsx` | Root component: 15+ state vars, scan logic, view routing (`main`/`batch`), history, drawings |
| `src/components/Chart.jsx` | SVG chart: candles, zoom (ctrl+wheel/pinch), pan, crosshair, H-Line/Box drawings, pattern highlights, liquidity box overlay |
| `src/components/SimpleView.jsx` | Compact result card: price, change%, action label, risk ring, top 2 patterns, entry/SL/target |
| `src/components/AdvancedView.jsx` | Extended view: adds bid/ask quote, exit timer, full 5-component breakdown, R:R |
| `src/components/BatchScanPage.jsx` | Index scanner: index selector, timeframe pills, progress bar, result cards with filter pills (Actionable/All + Buy/Short), search, passphrase modal |
| `src/components/GlobalMenu.jsx` | Hamburger menu: nav action (Stock Scanner ↔ Index Scanner) + signal category filters (8 checkboxes) |
| `src/components/Header.jsx` | Brand, status badge (LIVE/DEMO/NO DATA/READY), Simple/Advanced toggle, last scan time |
| `src/components/IndexConstituentsSidebar.jsx` | Slide-out modal: index dropdown + searchable symbol list |
| `src/engine/fetcher.js` | Yahoo Finance v8 fetch with fallback chain: Vite proxy → CF Worker → Jina Reader → allorigins. Optional `batchToken` header. Simulated data in dev. |
| `src/engine/patterns.js` | 46-rule pattern detection across 8 categories. Returns `{ name, direction, strength, reliability, category, candleIndices }` |
| `src/engine/liquidityBox.js` | Consolidation box detection (last 25 candles, segments 5-12 bars). ATR-relative thresholds, volume-aware scoring, breakout strength + trap depth |
| `src/engine/risk.js` | 5-component scoring: signal clarity (0-25), low noise (0-20), risk:reward (0-25), pattern reliability (0-15), confluence (0-15). Rescaled 40-100. Action thresholds: ≥72 STRONG, ≥58 BUY/SHORT, ≥50 WAIT |
| `src/engine/batchScan.js` | Throttled batch scanner: concurrency=5, delayMs=200, AbortSignal support. Reuses fetchOHLCV + patterns + box + risk per stock. Sorts by action rank then confidence |
| `src/engine/nseIndexFetch.js` | Fetch NSE index constituents: dev proxy → CF Worker → allorigins fallback |
| `src/engine/nseIndexParse.js` | Parse NSE JSON: filter series='EQ', deduplicate symbols |
| `src/engine/yahooQuote.js` | Yahoo v7 quote API for bid/ask (Advanced mode only) |
| `src/utils/batchAuth.js` | `getBatchToken()`, `setBatchToken()`, `hasBatchToken()`, `clearBatchToken()` — localStorage key `candlescan_batch_key` |
| `src/config/nseIndices.js` | `NSE_INDEX_OPTIONS` array (NIFTY 50 through NIFTY SMALLCAP 250), `DEFAULT_NSE_INDEX_ID` = 'NIFTY 200' |
| `src/data/signalCategories.js` | Category labels + `APPROX_PATTERN_RULES` count |
| `vite.config.js` | Base `/candlescan/`, dev proxies (`__candlescan-yahoo`, `__candlescan-nse`), VitePWA plugin config |
| `vite-plugin-chart-cache.mjs` | Vite middleware: intercepts chart requests, serves from/writes to `cache/charts/` |
| `worker/index.js` | Cloudflare Worker: CORS proxy (Yahoo + NSE), `X-Batch-Token` SHA-256 validation, IP rate limiting via KV |
| `worker/wrangler.toml` | Worker config + `RATE_LIMIT` KV namespace binding |
| `worker/OPS.md` | Operations guide: passphrase reset, deploy, troubleshooting |

---

## Data Flow

### Single Stock Scan
```
SearchBar input → App.runScan(symbol)
  → fetchOHLCV(symbol, timeframe, {batchToken?})
    → normalizeSymbol: RELIANCE → RELIANCE.NS, NIFTY50 → ^NSEI
    → Fallback chain: Vite proxy → CF Worker → Jina → allorigins
    → parseChartJson → trimTrailingFlatCandles
  → detectPatterns(candles)         # 46 rules, sorted by strength
  → detectLiquidityBox(candles)     # box detection + breakout/trap
  → computeRiskScore({candles, patterns, box})
    → 5 components summed → rescale 40-100 → action determination
  → setState: candles, patterns, box, risk → re-render Chart + View
```

### Batch Index Scan
```
BatchScanPage → Scan All → fetchNseIndexSymbolList(index)
  → batchScan({symbols, timeframe, batchToken, concurrency:5, delayMs:200})
    → Per stock: fetchOHLCV → detectPatterns → detectLiquidityBox → computeRiskScore
    → onProgress callback updates progress bar
  → Sort results: action rank desc → confidence desc
  → Display cards with filters (actionable/all, buy/short, search)
  → Tap card → App.onSelectSymbol → switch to main view + scan that stock
```

---

## View Routing (App.jsx)

The app has two parallel views managed by `view` state (`'main'` | `'batch'`):

```jsx
// Both views always mounted (display: none toggling)
// BatchScanPage keeps running in background when viewing a stock
<div style={{ display: view === 'batch' ? 'block' : 'none' }}>
  <BatchScanPage ... />
</div>
<div style={{ display: view === 'main' ? 'block' : 'none' }}>
  {/* SearchBar, Chart, SimpleView/AdvancedView */}
</div>
```

Navigation via shared GlobalMenu:
- On main view: menu shows "Index Scanner" → switches to batch
- On batch view: menu shows "Stock Scanner" → switches to main
- `cameFromBatch` flag shows "← Back to scan results" banner when drilling into a stock from batch results

---

## Chart Interactions (Chart.jsx)

- **Zoom**: Ctrl+wheel (desktop), pinch (mobile), or +/- buttons. Range: 30-300 visible candles
- **Pan**: Horizontal scroll/swipe. `panOffset` state
- **Crosshair**: Always-on hover with price pill + time pill
- **Drawing tools** (per-symbol, memory-only):
  - H-Line: horizontal line, draggable vertically
  - Box: rectangle with directional label (+X.X / -X.X / =0.0)
  - Clear: removes all drawings for current symbol
- **Pattern highlights**: Small colored circles on candles where patterns detected (toggle via checkbox)
- **Liquidity box overlay**: Dashed blue rectangle at box high/low with orange manipulation zones above/below
- **Touch**: Two-finger pinch zoom, single-finger pan
- **Responsive**: ResizeObserver for container width

---

## Risk Score Algorithm

### 5 Components (sum = 0-100 raw)

| Component | Max | Formula |
|-----------|-----|---------|
| Signal clarity | 25 | `topPattern.strength * 25` |
| Low noise | 20 | ATR / avgBody ratio — clean trends score higher |
| Risk:Reward | 25 | Entry=close, SL=5-bar swing low, Target=median(resistance, ATR*1.8, SL*1.5). R:R ≥ 3 → 25pts |
| Pattern reliability | 15 | `topPattern.reliability * 15` |
| Confluence | 15 | Volume spike(+5) + SMA alignment(+5) + context(+4) + box quality(+5), capped at 15 |

### Action Thresholds
- `confidence ≥ 72 + directional` → STRONG BUY / STRONG SHORT
- `confidence ≥ 58 + directional` → BUY / SHORT
- `confidence ≥ 50 + any pattern` → WAIT
- Below 50 or no pattern → NO TRADE

### Context Detection
- **at_support**: price within ATR of 15-bar low
- **at_resistance**: price within ATR of 15-bar high
- **breakout**: price beyond box high/low + ATR
- **mid_range**: otherwise

---

## Caching Layers

| Layer | Storage | TTL | Scope |
|-------|---------|-----|-------|
| Chart cache | Disk (`cache/charts/`) | 7 days | Dev only (Vite plugin) |
| NSE symbols | sessionStorage | 45 min | Browser tab |
| Mode + history | localStorage | Permanent | Browser |
| Batch token | localStorage | Permanent | Browser |
| HTTP cache | None (`no-store`) | N/A | All fetches |
| PWA assets | Service worker | Until new deploy | Browser |

---

## Auth & Rate Limiting

### Batch Auth Flow
1. User enters passphrase → stored in localStorage (`candlescan_batch_key`)
2. `fetchOHLCV` sends `X-Batch-Token: <passphrase>` header to CF Worker
3. Worker computes `SHA256(passphrase)`, compares to `env.BATCH_AUTH_HASH`
4. Match → process request (no rate limit). Mismatch → 403

### Rate Limiting (unauthenticated)
- KV key: `rl:{SHA256(IP)}:{YYYY-MM-DD}`
- Limit: 20 requests/day per IP
- TTL: 86400s (auto-expires)
- Authenticated requests bypass entirely

### Worker Allowed Origins
```javascript
['https://utkarsh9891.github.io', 'http://localhost', 'http://127.0.0.1',
 'https://localhost', 'capacitor://localhost']
```

---

## PWA Details

- **Plugin**: `vite-plugin-pwa` with `registerType: 'autoUpdate'`
- **Manifest**: name "CandleScan", standalone display, portrait orientation
- **Icons**: SVG at `public/icons/icon-192.svg` and `icon-512.svg`
- **Service worker**: Workbox-generated, caches `**/*.{js,css,html,svg,png}`
- **Runtime caching**: `NetworkOnly` for CF Worker URLs (always fresh data)
- **Auto-update**: On new deploy, SW detects change and updates on next visit

---

## CRITICAL: Three Code Paths Must Stay in Sync

Signal generation runs in three places. **Any change to one MUST be applied to all three.**

| Path | File | Purpose |
|------|------|---------|
| CLI simulation | `scripts/simulate-day.mjs` (`runWindow`) | Offline backtesting via CLI |
| Browser simulation | `src/engine/simulateDay.js` (`runSimulation`) | In-app simulation page |
| Index scan | `src/engine/batchScan.js` (`batchScan`) | Live "Scan All" in Index Scanner |

All three must use:
- Same engine functions (scalp/v2/classic) via `engineFns` parameter
- Same ORB/prevDay computation per stock
- Same `indexDirection` passed to `computeRiskScore`
- Same `barIndex` passed to both `detectPatterns` and `computeRiskScore`
- Same pre-window candle context (09:15 bars) in lookback
- Same volume filtering (25th percentile auto-detect)
- Same defaults: `minConfidence=80`, `skipFirstBars=0`

**Before merging any signal/scoring change, grep all three files to verify parity.**

---

## CRITICAL: Engine Identity Constraints

Each engine represents a fundamentally different trading style. **Never tune parameters past these hard limits — they define what the engine IS.**

### Scalp Engine (`risk-scalp.js`, `patterns-scalp.js`)
| Constraint | Hard Limit | Why |
|------------|-----------|-----|
| **maxHoldBars** | **≤ 15** (15 min on 1m) | Scalping = quick in-and-out. Anything longer is intraday. |
| **Timeframe** | **1m only** | Scalping needs bar-by-bar precision. |
| **Window** | **09:30–11:00 IST** | Morning volatility window. |
| **Hold duration** | **5–15 min typical** | If most trades hold 20+ min, the engine has drifted. |

### Intraday Engine (`risk-v2.js`, `patterns-v2.js`)
| Constraint | Hard Limit | Why |
|------------|-----------|-----|
| **maxHoldBars** | **No limit / full day** | Intraday can hold until close. |
| **Timeframe** | **5m / 15m** | Wider bars for longer holds. |
| **Window** | **Full session** | 09:15–15:30 IST. |

### Classic Engine (`risk-classic.js`, `patterns-classic.js`)
| Constraint | Hard Limit | Why |
|------------|-----------|-----|
| **Hold duration** | **3–4 days** | Swing trading across sessions. |
| **Timeframe** | **1d** | Daily candles for multi-day patterns. |

**Tests enforce these constraints** — see `risk-scalp.test.js`. If a tuning change makes a test fail, the change violates engine identity and must be reconsidered.

---

## Deployment & Versioning

> **Full guide: [`GIT_WORKFLOW.md`](GIT_WORKFLOW.md)** — read this before making any commits.

**Key rules for coding agents:**
- Direct push to `main` is **blocked**. Always use a PR (`gh pr create` → `gh pr merge <n> --merge`).
- Version comes from **git tags only** (no version field in package.json). Do not add one.
- **Do not create tags manually.** CI auto-tags every merge to `main` with the next patch version.
- Pre-push hook runs `npm test && npm run build`. Do not skip it.
- Merge method: `--merge` only (no `--squash`, no `--rebase`).

### Cloudflare Worker
```bash
cd worker
npx wrangler deploy                    # Deploy code
npx wrangler secret put BATCH_AUTH_HASH  # Set/rotate passphrase hash
```
Full guide: `worker/OPS.md`

---

## Conventions

- **No TypeScript** — plain JavaScript + JSX
- **No CSS files** — inline styles everywhere
- **No state library** — useState/useEffect only
- **No external charting** — custom SVG
- **Monospace**: `'SF Mono', Menlo, monospace` for prices
- **Colors**: blue `#2563eb`, green `#16a34a`, red `#dc2626`, orange `#d97706`, gray `#8892a8`
- **Container**: max-width 620px, centered, mobile-first
- **Error handling**: try-catch around localStorage, fetch, JSON.parse

## Testing

### Framework: Vitest
Configured in `vite.config.js` (`test` block). Tests live alongside source files as `*.test.js`.

```bash
npm test            # Run all tests once (vitest run)
npm run test:watch  # Watch mode
```

### Test files
| File | Tests |
|------|-------|
| `src/engine/patterns.test.js` | Pattern detection: bullish/bearish engulfing, hammer, field validation, sorting, edge cases |
| `src/engine/risk.test.js` | Risk scoring: confidence range, direction, action labels, entry/SL/target, context detection |
| `src/engine/liquidityBox.test.js` | Box detection: consolidation, breakout, quality score, index bounds, empty input |
| `src/engine/fetcher.test.js` | `trimTrailingFlatCandles`, `TIMEFRAME_MAP` validation |
| `src/config/nseIndices.test.js` | Custom index CRUD, dedup, merge with built-in, localStorage mock |
| `src/utils/batchAuth.test.js` | Token get/set/has/clear with localStorage mock |

### Test fixtures
`src/engine/__fixtures__/candles.js` — reusable candle data sets:
- `bullishEngulfing`, `bearishEngulfing`, `hammerPattern` — pattern triggers
- `consolidation`, `consolidationBreakout` — box detection data
- `withTrailingFlats` — flat candle trimming
- `sideways` — no-pattern data
- `yahooChartJson` — mock API response

### Pre-push hook
`.git-hooks/pre-push` runs `npm test && npm run build` before every push. Auto-configured via `npm install` (`prepare` script sets `core.hooksPath`). Bypass: `git push --no-verify`.

### Adding new tests
- Create `*.test.js` next to the source file
- Import from `vitest` (`describe`, `it`, `expect`, `vi`)
- For localStorage-dependent code, use `vi.stubGlobal('localStorage', mock)`
- Add test candle data to `__fixtures__/candles.js` if needed
