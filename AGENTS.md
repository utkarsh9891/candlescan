# AGENTS.md — Coding Agent Guide for CandleScan

> This file helps AI coding agents (Claude, Cursor, Copilot, Aider, etc.) understand the project quickly.

## What is this project?
CandleScan is a React + Vite mobile-first web app for NSE (National Stock Exchange of India) candlestick pattern detection, liquidity box analysis, and risk scoring. It fetches OHLCV data from Yahoo Finance and renders interactive SVG charts.

## Quick commands
```bash
npm install          # Install dependencies
npm start            # Dev server at http://127.0.0.1:5173/candlescan/
npm run build        # Production build → dist/
npm run preview      # Serve built files locally
```

## Dev server with simulated data (no network needed)
```bash
# Open http://127.0.0.1:5173/candlescan/?simulate=1
npm start
```

## Architecture
- **Framework**: React 18, Vite 6, no external charting library
- **Entry**: `src/main.jsx` → `src/App.jsx`
- **State management**: React useState/useEffect (no Redux/Context)
- **Chart**: Custom SVG in `src/components/Chart.jsx`
- **Analysis engine**: `src/engine/` (fetcher, patterns, liquidityBox, risk)
- **Deployment**: GitHub Actions → GitHub Pages at `utkarsh9891.github.io/candlescan/`
- **CORS proxy**: Cloudflare Worker at `worker/` for Yahoo Finance + NSE India `/api/*`
- **Index constituents**: NSE `equity-stockIndices` at runtime (`src/engine/nseIndexFetch.js`); dev uses Vite proxy `/candlescan/__candlescan-nse`
- **Local chart cache**: `cache/charts/` (gitignored) — `vite-plugin-chart-cache.mjs` + `scripts/lib/chart-cache-fs.mjs`; `npm run cache:charts` / `test:batch`

## Key files
| File | Purpose |
|------|---------|
| `src/App.jsx` | Root component, state orchestration, scan logic |
| `src/components/Chart.jsx` | SVG chart: candles, zoom, pan, crosshair, drawings, highlights |
| `src/engine/fetcher.js` | Yahoo Finance data fetching with proxy fallback chain |
| `src/engine/patterns.js` | Candlestick pattern detection (8 categories, returns candleIndices) |
| `src/engine/liquidityBox.js` | Consolidation box detection |
| `src/engine/risk.js` | 5-component risk scoring (0-100), action determination |
| `src/config/nseIndices.js` | NSE index catalog + default index id |
| `src/engine/nseIndexFetch.js` | Fetch & parse index constituents (browser) |
| `src/data/niftyStocks.js` | Deprecated stub; re-exports config only |
| `src/components/SimpleView.jsx` | Main decision display (Action → Score → Details) |
| `src/components/SignalFilters.jsx` | Dropdown signal filter popover |
| `vite.config.js` | Build config, base path `/candlescan/`, dev proxy |
| `worker/index.js` | Cloudflare Worker CORS proxy (Yahoo chart + NSE API) |

## Chart interactions (Chart.jsx)
- **Zoom**: ctrl+wheel (trackpad pinch) or +/- buttons
- **Pan**: scroll/swipe left-right, panOffset state
- **Crosshair**: always-on hover with price + time pills
- **Drawing tools**: H-Line (draggable), Box (directional +/- display)
- **Highlights**: pattern candle annotations when toggle enabled

## Data flow
1. User enters symbol → `fetchOHLCV(symbol, timeframe)`
2. Yahoo Finance API → candle array `[{t, o, h, l, c, v}]`
3. `detectPatterns(candles)` → pattern array with candleIndices
4. `detectLiquidityBox(candles)` → consolidation box
5. `computeRiskScore({candles, patterns, box})` → action, confidence, entry/sl/target

## Testing
No test framework configured. Verify manually:
```bash
npm run build                    # Must succeed with no errors
curl -s http://127.0.0.1:5173/candlescan/ | grep -q "CandleScan" && echo "ok"
```

## Conventions
- Inline styles (no CSS files/modules)
- No TypeScript — plain JSX
- No external state library
- Monospace font for prices: `'SF Mono', Menlo, monospace`
- Color palette: blue (#2563eb), green (#16a34a), red (#dc2626), orange (#d97706), gray (#8892a8)
