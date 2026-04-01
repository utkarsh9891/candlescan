# Chart Cache (Local Dev Only)

Date-partitioned cache for Yahoo Finance v8 chart JSON responses. Speeds up development by avoiding repeated Yahoo API calls.

**This cache is dev-only.** Production (GitHub Pages) always fetches live data via the Cloudflare Worker.

## Structure

```
cache/charts/{SYMBOL}/{interval}/{YYYY-MM-DD}.json
```

Example:
```
cache/charts/RELIANCE.NS/1m/2026-03-24.json
cache/charts/RELIANCE.NS/5m/2026-03-24.json
cache/charts/TCS.NS/1m/2026-03-17.json
```

Each file contains one trading day's OHLCV data for one symbol at one interval.

## Cache warming

```bash
npm run cache:charts     # Warm latest data for an index (range-based, split by date)
npm run cache:march      # Warm all March 2026 trading days for NIFTY 200 + MIDCAP 150 + SMALLCAP 250
```

## Gitignored

All `.json` files under this directory are gitignored. Only this README is tracked.
