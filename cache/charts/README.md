# Chart Cache (Local Dev Only)

Local disk cache for Yahoo Finance v8 chart JSON responses. Speeds up development by avoiding repeated Yahoo API calls for the same symbol/timeframe.

**This cache is dev-only.** Production (GitHub Pages) always fetches live data via the Cloudflare Worker.

---

## How It Works

### File Format
```
cache/charts/{SYMBOL}_{INTERVAL}_{RANGE}.json
```

Examples:
```
cache/charts/RELIANCE.NS_5m_5d.json
cache/charts/TCS.NS_1d_6mo.json
cache/charts/^NSEI_15m_5d.json
```

Each file is the raw JSON response from Yahoo Finance v8 chart API, stored as-is.

### Cache Behavior

| Context | Read | Write | Notes |
|---------|------|-------|-------|
| `npm start` (Vite dev) | Yes | Yes | Vite middleware intercepts `/__candlescan-yahoo/v8/finance/chart/*` requests |
| `npm run test:batch` | Yes | Yes | Node script reads/writes via `scripts/lib/chart-cache-fs.mjs` |
| `npm run cache:charts` | No | Yes | Pre-warms cache for all symbols in an index |
| `npm run build` / Pages | No | No | Production never uses disk cache |

### Vite Plugin (`vite-plugin-chart-cache.mjs`)

The custom Vite middleware intercepts dev chart requests:

1. **Cache hit** (file exists + fresh): Serves JSON from disk. Response header: `X-CandleScan-Chart-Cache: hit`
2. **Cache miss** (file missing or stale): Fetches from Yahoo Finance, saves to disk, serves response. Header: `X-CandleScan-Chart-Cache: miss`

Check the header in browser DevTools Network tab to confirm cache behavior.

---

## Staleness & TTL

Default max age: **7 days** (from file mtime).

### Override max age
```bash
# Set to 1 hour
CANDLESCAN_CHART_CACHE_MAX_AGE_MS=3600000 npm start

# Never expire (use until manually deleted)
CANDLESCAN_CHART_CACHE_MAX_AGE_MS=0 npm start
```

### Force refresh
```bash
# Delete a specific cached file
rm cache/charts/RELIANCE.NS_5m_5d.json

# Delete all cached files
rm cache/charts/*.json

# Batch test with forced refresh
node scripts/batch-test.mjs 5m --refresh-charts
```

---

## Disable Cache Entirely

Always fetch live from Yahoo (slower, but guaranteed fresh):

```bash
CANDLESCAN_CHART_CACHE=0 npm start
```

Or for batch tests:
```bash
node scripts/batch-test.mjs 5m --no-chart-cache
```

---

## Pre-Warming the Cache

Fetch chart data for all symbols in an index ahead of time:

```bash
# Warm cache for NIFTY 50 at 5m timeframe
npm run cache:charts

# Warm for a specific index
node scripts/warm-chart-cache.mjs --index "NIFTY 200" --interval 5m
```

This is useful before running batch tests offline or on slow connections.

---

## Disk Usage

Typical file size: 50-200 KB per JSON file.

| Index | Approx files | Approx size |
|-------|-------------|-------------|
| NIFTY 50 | 50 | ~5 MB |
| NIFTY 200 | 200 | ~20 MB |
| NIFTY 500 | 500 | ~50 MB |

---

## Git

- JSON files are **gitignored** (`cache/charts/.gitignore`)
- Only this `README.md` and `.gitignore` are tracked
- Safe to delete entire `cache/charts/` contents anytime — they regenerate on next dev fetch
