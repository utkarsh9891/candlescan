# v0.16.0 — Signal engine retune, data-plane hardening, UX additions

**Released**: 2026-04-21

Shipped in one focused session spanning 22 merged PRs. The headline is a **66% lift in 17-day backtest P&L (+Rs 22,639 → +Rs 37,529)** from three empirical tunes on top of honest instrumentation, plus a full data-plane hardening pass so scans and simulations stay responsive regardless of upstream vendor health.

---

## 🎯 Backtest results (17-day pessimistic-fills, NIFTY SMALLCAP 100)

| Stage | In-sample 17d P&L | OOS mean/day | Profit factor | Max drawdown |
|---|---:|---:|---:|---:|
| v0.15.0 baseline (optimistic fills) | +Rs 49,296 | n/a | 1.65 | Rs 31,770 |
| v0.15.0 + pessimistic fills | +Rs 22,639 | Rs 2,525 | 1.91 | Rs 31,770 |
| + HIGH-VIX veto + rs ≥ 1.5 | +Rs 28,537 | Rs 3,161 | 10.49 | Rs 4,330 |
| **v0.16.0 (regime-aware SL ON)** | **+Rs 37,529** | **Rs 3,852** | **12.57** | **Rs 4,330** |

The 23-day sweep (Mar 12 – Apr 21) out-of-sample numbers: sum Rs 50,080, mean Rs 3,852/day, PF 12.57, DD Rs 4,330. Max drawdown dropped **86%** vs v0.15.0. Apr 21 (release day) produced 3 trades, 3 wins, Rs 27,955 net.

---

## Signal engine

- **HIGH-VIX regime veto** — empirical: HIGH-VIX trades had PF 1.01 (zero-edge) vs 2.46 non-HIGH. `regimeGate` now rejects HIGH outright. (PR #182)
- **Relative-strength gate tightened** — pattern now requires `rs ≥ 1.5%` (was 0.8%). Analyse-trades showed rs 1.0–1.5% bucket at PF 0.05; ≥ 1.5 at PF 2.81. (PR #189)
- **Regime-aware ATR-based SL/target** — `NORMAL=1.5, LOW=1.2, RR=1.8, slFloor=0.005, slCap=0.012`. At RR 1.8 the post-clamp rr falls below the hard 2.0 min-rr gate for wide-ATR bars, dropping historically-wide-stop losers upstream. Default ON. Flip with `--no-regime-stops`. (PR #201)
- **VIX/liquidity delta reconcile** — positive confidence deltas on non-news layers flattened to 0 per CLAUDE.md §4. Only news sentiment gets bonuses. (PR #182)
- **Flow alignment wired into sizeMultiplier** — FII/DII institutional flow now modulates position size (±20% aligned/opposing). Previously a no-op. Live FII/DII fetch wired in batchScan. (PRs #186, #192)
- **Sector map refreshed** — 14 stale NSE-symbol entries removed (9 banks post-restructuring, 4 pharma→healthcare, 1 energy). (PR #191)

## Infrastructure & instrumentation (Phase A P0)

- **Gate-level trade attribution** — every trade now persists a feature vector (`intraPct, rs, vwapDist, volFactor, pullbackPct, emaDiff, preWindowMove, vixRegime, liquidity, sentiment, sizeMult, consecutiveLosses`) to `cache/trades/<date>.json`. (PR #178)
- **Pessimistic fills** — 0.03% entry+exit slippage + probabilistic intra-bar straddle heuristic. `--pessimistic-fills` default ON. (PR #180)
- **Walk-forward harness** — `scripts/walk-forward.mjs` parallel `child_process` workers, 6-way concurrency, rolling 10-train/3-test windows. Full 23-day sweep in 52s. (PR #179)
- **Confidence→WR calibration** — `scripts/analyse-trades.mjs` buckets trades by confidence, rs, volFactor, intraPct, VIX regime. (PRs #177, #181)
- **Browser/CLI sim parity** — `simulateDay.js` now builds real marketContext (was `null`). (PR #178)
- **Time-window sweep** — `scripts/time-window-sweep.mjs` parallel validation across trading windows. Confirmed 09:30–11:00 retains edge on larger sample. (PRs #187, #200)
- **Sector-map freshness checker** — `scripts/check-sector-map-freshness.mjs` diffs against live NSE indices. (PR #183)

## Data-plane hardening (rate-limit & caching)

Full audit produced design doc, then implementation across browser + CF Worker:

- **Browser rate-limit queues** — semaphore caps: Yahoo 3, Dhan 5, Kite 2. Exponential-backoff retry on 429/5xx. (PR #196)
- **localStorage chart cache** — date-partitioned, 30-day TTL for historical dates, **today's bars never cached** (live-data correctness). (PR #196)
- **localStorage NSE index cache** — 7-day TTL with stale-fallback when NSE is flaky. (PR #193)
- **Worker KV caches** — VIX (1h market/24h off-hours), FII/DII (6h), Moneycontrol (10m/60m), Google News (4h) — all with stale-cache fallback on upstream failure. Returns `X-Cache: HIT|STALE|MISS|UNAVAILABLE` headers. (PR #198)
- **Browser news fallback chain** — 4-tier: in-memory → localStorage → Worker (with STALE handling) → Moneycontrol → null. Scans never fail on Google News 502s. (PR #199)
- **Dhan scrip master auto-refresh** — 5-day background refresh if localStorage is stale. (PR #196)
- **News endpoint load-test tool** — `scripts/load-test-news.mjs` for periodic capacity verification. (PR #190)

## UX

- **TradingView Single Ticker Widget** — sticky top strip showing live NIFTY 50 / BANK / IT / SMALLCAP / MIDCAP / VIX price. Index picker in Settings; choice saved per-device. (PR #195)
- **Broker token expiry banner** — Dhan/Kite 401/403 now surfaces a dedicated "reconnect broker" banner instead of silently-empty scans. (PR #185)

## Cache universe

- `--from-cache` flag on `warm-chart-cache.mjs` warms exactly the 823 symbols on disk. April 13/15/16/20/21 data cached for the full universe across 1m / 5m / 15m timeframes. (PR #176)

---

## Files index

### New files this release

```
src/components/SingleTickerWidget.jsx           # TradingView ticker embed
src/components/SingleTickerPicker.jsx           # Index picker dropdown
src/components/TokenExpiryBanner.jsx            # Broker-reconnect banner
src/engine/brokerErrors.js                      # TokenExpiredError class
src/engine/rateLimit.js                         # Semaphore + backoff utils
src/engine/chartCacheLocal.js                   # Date-aware chart LS cache
src/engine/newsCacheLocal.js                    # News LS cache
src/engine/nseIndexCache.js                     # NSE index LS cache
src/engine/sector-freshness.js                  # Sector drift diff helper
worker/cache.js                                 # KV cache flow + dedupe
scripts/walk-forward.mjs                        # Parallel sweep harness
scripts/analyse-trades.mjs                      # WR calibration
scripts/time-window-sweep.mjs                   # Window A/B tester
scripts/check-sector-map-freshness.mjs          # NSE drift checker
scripts/load-test-news.mjs                      # Worker endpoint load tool
```

### Cache artifacts this release writes

```
cache/trades/<date>.json                  # per-trade feature vectors
cache/walk-forward/wf-<ts>.json           # sweep results
cache/analysis/confidence_wr_<ts>.json    # WR calibration tables
cache/sector-map-diff/sector-diff-<ts>.json
cache/load-test/news-<ts>.json
cache/time-window-sweep/window-sweep-<ts>.json
```

---

## Upgrade notes

- CLI `simulate-day.mjs` defaults to `--pessimistic-fills` ON and `--regime-stops` ON. Pass `--no-pessimistic-fills` and `--no-regime-stops` to reproduce the v0.15.0 optimistic numbers.
- Browser sim now consumes marketContext; `flow: null` sentinel paths degrade gracefully when live FII/DII is unavailable.
- `package.json` still has no `version` field — it's derived via `git describe --tags` at build time.

## Non-negotiable floor

**17-day net P&L must not regress below +Rs 19,000** (pessimistic-fills pre-Wave-1 reference). Any strategy change that regresses below this floor is blocked per CLAUDE.md §9.

## Next

Phase B (AI judge) remains out of scope per user decision.
