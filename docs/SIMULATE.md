# Local Simulation

The CLI is the canonical backtest path — there is no in-app simulation surface. Strategy changes must clear it before shipping.

## Single-day run

```bash
# Scalp (1m) — Wave 3 default
node scripts/simulate-day.mjs 1m \
  --index "NIFTY SMALLCAP 100" --date 2026-04-21 --engine scalp \
  --confidence 75 --max-positions 3 --max-trades 5 \
  --size-tiers '82:200000,75:100000'

# Intraday (5m or 15m)
node scripts/simulate-day.mjs 5m \
  --index "NIFTY 500" --date 2026-04-21 --engine intraday \
  --confidence 75 --max-positions 3 --max-trades 5 \
  --size-tiers '82:200000,75:100000'

# Delivery (1d) — same shape, but multi-day exits live in walk-forward
node scripts/simulate-day.mjs 1d \
  --index "NIFTY 100" --date 2026-04-21 --engine delivery \
  --confidence 75 --max-positions 3 --max-trades 2
```

`npm run simulate:run -- ...` is the npm wrapper for the same script. Pick any NSE trading day for `--date` — if the chart cache already has bars for that date, the run is near-instant; otherwise it falls back to Yahoo and warms the cache as it goes.

## Walk-forward (Mar 12 → today)

```bash
node scripts/walk-forward.mjs --engine scalp \
  --size-tiers '82:200000,75:100000' --regime-stops

# Intraday timeframe A/B
node scripts/walk-forward.mjs --engine intraday --timeframe 5m \
  --size-tiers '82:200000,75:100000'
```

Defaults: `--from 2026-03-12`, `--to` today IST, `--train-days 10`, `--test-days 3`, `--regime-stops` ON, `--timeframe 1m`.

## Flags you'll actually use

| Flag | Meaning |
|---|---|
| `--engine scalp\|intraday\|delivery` | strategy selector |
| `--date YYYY-MM-DD` | simulate this trading day (defaults to last trading day) |
| `--index "NAME"` | NSE index name (matches dropdown labels) |
| `--confidence N` | min confidence to take a trade (default 75) |
| `--max-positions N` | parallel positions (Wave 3 = 3) |
| `--max-trades N` | per-day trade cap |
| `--size-tiers '82:200000,75:100000'` | Wave 3 tier sizing — high-conf gets 2L, others 1L |
| `--position-size RS` | flat sizing fallback if tiers omitted |
| `--regime-stops` / `--no-regime-stops` | Wave 2a ATR-based SL/target (ON by default in walk-forward, OFF in single-day) |
| `--save-trades` / `--no-save-trades` | write `cache/trades/<date>.json` (ON by default) |
| `--multi-window` | scan in 30-min windows instead of one full session |

Unknown flags are ignored for forward-compat. Run any script with `--help` for the full list.

## Output

Trades + summary print to stdout. With `--save-trades` (default), the run also writes:

```
cache/trades/<YYYY-MM-DD>.json
```

containing `{ date, runMeta, summary, trades[] }`. Replay-validate against the peer-trade gate any time:

```bash
node scripts/replay-reference-trades.mjs   # must keep ≥6/8 firing
```

## Validation gates before shipping a strategy change

1. `npm test` — full suite
2. `node scripts/replay-reference-trades.mjs` — ≥6/8 reference trades fire
3. Walk-forward on Mar 12 → today doesn't regress per-engine baselines

## Warming the chart cache

Chart bars live in the sibling `../candlescan-cache` repo (resolved by `scripts/lib/cache-root.mjs`). Override with `CANDLESCAN_CACHE_DIR=/path env`. To warm a specific date range across NIFTY 200 + MIDCAP 150 + SMALLCAP 250 (~600 stocks) at 1m/5m/15m:

```bash
node scripts/warm-cache.mjs --from 2026-03-12 --to 2026-05-09 --skip-existing
```

To warm a single index for one timeframe (faster, smaller scope):

```bash
npm run cache:warm:charts -- 5m --index "NIFTY SMALLCAP 100"
```

To warm + auto-commit + push to the cache repo in one step:

```bash
npm run cache:sync
```
