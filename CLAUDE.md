# CLAUDE.md

This file is auto-loaded by Claude Code at every session start. It contains the rules and context that must always be in effect when working in this repo.

**For deep architecture, engine internals, data flow, and history — see [`docs/AGENTS.md`](docs/AGENTS.md).** This file is intentionally short.

---

## Project identity

**CandleScan** — React 18 + Vite 6 PWA for NSE candlestick pattern scanning, scalp signal detection, and trading simulation. Deployed to GitHub Pages. Backend is a Cloudflare Worker that proxies Yahoo Finance, NSE, Zerodha Kite, and Dhan HQ. Plain JSX (no TypeScript), inline styles (no CSS files), React hooks only (no Redux).

## Engines

Three canonical engines (Settings labels match internal codes since Wave 3 / PR #208):

| Code | Label | Timeframe | Hold | Pattern file |
|---|---|---|---|---|
| `scalp` | Scalp | 1m | ≤20 min | [`src/engine/patterns-scalp.js`](src/engine/patterns-scalp.js) — single "Strong Momo Pullback" |
| `intraday` | Intraday | 5m or 15m | full session, EOD exit | [`src/engine/patterns-v2.js`](src/engine/patterns-v2.js) — multi-pattern (engulfing/piercing/hammer/etc) + **Intraday Momentum Runner** (PR #211) |
| `delivery` | Delivery | 1d | multi-day | [`src/engine/patterns-classic.js`](src/engine/patterns-classic.js) — daily-bar swing patterns |

Legacy aliases `v1` (→ delivery), `v2` (→ intraday), `classic` (→ delivery) are accepted at every boundary (localStorage, CLI flags) and normalized via `normalizeEngine()` in [`src/data/signalCategories.js`](src/data/signalCategories.js). Always use canonical names in conditionals.

---

## Non-negotiables (hard rules)

1. **Branch protection**: Never push directly to `main`. All work goes through a PR via `gh pr create` → `gh pr merge <n> --merge --delete-branch`. Merge method is `--merge` only — never `--squash` or `--rebase`.

2. **Version / tags**: **Do not create git tags manually.** CI auto-tags every merge to main — **patch** by default, or **minor/major when the PR carries the `release:minor` / `release:major` label at merge time** (apply the label *before* merging; applying it after has no effect). `package.json` has no `version` field — it comes from `git describe --tags` at build time via `vite.config.js`. See [`docs/GIT_WORKFLOW.md`](docs/GIT_WORKFLOW.md) for the full label flow.

3. **Tests and build before push**: Pre-push hook runs `npm test && npm run build`. Do not bypass with `--no-verify` unless the user explicitly asks.

4. **No ranking-shift layer bonuses, plus HIGH-VIX veto**: In `src/engine/marketContext.js`, positive confidence bonuses from day-level context layers (VIX, gap, liquidity, flow) are **kept at 0** by design. Bonuses shift candidate ranking and displace high-quality winners with marginally-boosted losers. Only news sentiment gets positive bonuses (it's the strongest predictive signal). Vetoes are fine — they just remove bad trades. A **HIGH-VIX regime veto** is active in `regimeGate` (validated via walk-forward 2026-04-21: HIGH-VIX trades had PF 1.01 vs 2.46 non-HIGH — empirically zero-edge). If tempted to add a bonus to any non-news layer, re-read the empirical sweep table in `docs/INTEGRATIONS.md`.

5. **No lookahead in simulations**: Every time-series lookup must use `t <= curTs`, not `t < curEnd` or full-day aggregates. Index direction uses pre-window move, NOT EOD. Sector intraday % uses the latest bar at or before the stock bar's timestamp. Audit any new time-series code for lookahead before shipping.

6. **5x margin is default** in the simulator. `shares = floor((positionSize × MARGIN_MULTIPLIER) / entry)`. Wave 3: Rs 5L corpus, **up to 3 parallel positions, max 30L exposure**. Base position from confidence tiers via `sizingTier()` in [`src/engine/tradeDecision.js`](src/engine/tradeDecision.js): `DEFAULT_SIZE_TIERS = [{conf: 82, size: 200000}, {conf: 75, size: 100000}]` — high-confidence trades get Rs 2L (10L exposure), 75-81 get Rs 1L (5L exposure). Pass `--size-tiers '82:200000,75:100000'` to the simulator/walk-forward to enable; omit for the legacy flat `--position-size`. P&L magnitudes are reported on the leveraged exposure, not raw capital.

7. **Premium broker tx cost**: `TX_COST_PCT = 0.0002` (0.02% per side, 0.04% round-trip = ~Rs 600 per trade on 15L). This matches the app owner's actual broker plan, not standard retail. Do not change this without an explicit user instruction.

8. **Scalp engine: single pattern only.** [`src/engine/patterns-scalp.js`](src/engine/patterns-scalp.js) ships ONE pattern — the "Strong Momo Pullback". Do not add additional scalp patterns or variants. The entire fusion / boxTheory / quickFlip / touchAndTurn variant system was removed because firing many patterns produced many mediocre signals. One strict gate > seven permissive ones. **This rule applies to scalp only** — the intraday engine ([`patterns-v2.js`](src/engine/patterns-v2.js)) intentionally hosts multiple patterns (reversal suite + Intraday Momentum Runner from PR #211); each one must individually pass strict gates and the replay validation at [`scripts/replay-reference-trades.mjs`](scripts/replay-reference-trades.mjs).

---

## Workflow commands

```bash
npm start            # dev server at 127.0.0.1:5173/candlescan/
npm test             # 561 unit tests (vitest)
npm run build        # production build → dist/
npm run simulate     # CLI simulation: node scripts/simulate-day.mjs
npm run cache:charts # warm local chart cache (writes to sibling candlescan-cache repo)
npm run cache:sync   # warm + auto-commit + push to candlescan-cache
```

CLI simulation is the primary tool for backtesting strategy changes. Wave 3 default — 3 parallel positions, confidence-tiered sizing, all canonical engine names accepted:

```bash
# Scalp baseline (Wave 2a + tier sizing):
node scripts/simulate-day.mjs 1m \
  --index "NIFTY SMALLCAP 100" --date 2026-04-22 --engine scalp \
  --confidence 75 --max-positions 3 --max-trades 5 \
  --size-tiers '82:200000,75:100000'

# Intraday (PR #211 momentum runner):
node scripts/simulate-day.mjs 5m \
  --index "NIFTY 500" --date 2026-04-22 --engine intraday \
  --confidence 75 --max-positions 3 --max-trades 5 \
  --size-tiers '82:200000,75:100000'
```

Walk-forward window: **Mar 12 - today (28+ days)**. Pass `--timeframe 15m` to walk-forward to A/B intraday timeframes. Replay reference peer trades with `node scripts/replay-reference-trades.mjs` (PR-A2 gating script).

Any strategy change must be validated on the rolling window before shipping. **Replay must keep ≥6/8 reference trades firing** (current: 7/8 after PR #211).

---

## Target & current state

**Per-engine daily P&L targets (Wave 3, user-set):**

| Engine | Daily target | Stretch | Notes |
|---|---|---|---|
| Scalp | Rs 10k+ | Rs 15k | Per-trade ≥0.5% on leveraged exposure (no Rs 3-4k "shitty" trades) |
| **Intraday** | **Rs 25-30k+** | **Rs 1L** | **Primary P&L lever** — captures 5-20% momentum runners on smallcaps |
| Delivery | Rs 5-10k | — | Multi-day, lumpy. Diversifier only; CLI sim path deferred to PR-D |

**Capital**: Rs 5L corpus, up to 3 parallel positions, tier sizing per `DEFAULT_SIZE_TIERS`. Max 30L exposure at 5x.

**Validation gates** (every strategy PR must clear):
1. `npm test` — full suite passes (561+ tests)
2. `node scripts/replay-reference-trades.mjs` — **≥6/8 peer-validated trades fire** in their direction with conf ≥75 (current: 7/8 after PR #211)
3. Walk-forward on Mar 12 - today doesn't regress per-engine baselines

**Recent baselines:**
- **Scalp** (Wave 2a, regime-aware stops ON): +Rs 37,530 over 17 days (Mar 12 - Apr 10), ~Rs 2,200/day, PF 3.11, win rate ~42.8%. Floor: don't regress below +Rs 19,000 / 17-day net P&L.
- **Intraday** (PR #211 — Intraday Momentum Runner shipped): replay shows 7/8 reference trades fire correctly (was 4/8 pre-PR). Full walk-forward baseline pending; legacy V2 had no walk-forward.
- **Delivery**: simulator path not yet wired (PR-D); only browser path exists.

The Wave 2a scalp tuning ships `REGIME_STOPS_DEFAULTS` in [`src/engine/risk-scalp.js`](src/engine/risk-scalp.js) as `NORMAL=1.5, LOW=1.2, RR=1.8, slFloor=0.005, slCap=0.012, targetCap=0.030`. Wave 3 intraday ships `INTRADAY_REGIME_STOPS_DEFAULTS` in [`src/engine/risk-v2.js`](src/engine/risk-v2.js) as `slMultRunner=2.5, targetPctRunner=0.08` (only applied when the Intraday Momentum Runner pattern fires).

Walk-forward harness ([`scripts/walk-forward.mjs`](scripts/walk-forward.mjs)) defaults: `--regime-stops` ON, `--timeframe 1m`, no tier sizing. Pass `--size-tiers '82:200000,75:100000'` for Wave 3 sizing, `--timeframe 5m`/`15m` for intraday A/B.

---

## Common gotchas

- **ES module imports only** — no `require()` in src/. Use `import` / `export`.
- **Inline styles** — no CSS files. Use `style={{ ... }}` or the shell style objects in App.jsx.
- **Service worker caches the CF Worker domain for both GET and POST** — if you add new endpoints, verify in dev that they aren't being cached stale.
- **Touch handlers use refs, not state deps** — `useEffect` for touch/wheel handlers has `[]` deps. Values read inside handlers come from refs (`countRef`, `panOffsetRef`, etc.). This is intentional and fixed a whole class of "scroll doesn't work until zoom button clicked" bugs.
- **OHLCV bar cross button** uses `flexShrink: 0` on a dedicated container — don't change the flex layout without testing on 4-digit-price stocks like SHRIRAMFIN.
- **Dhan timestamps are epoch seconds** — never wrap them in `new Date(ts)` because that treats them as milliseconds and produces garbage.

---

## File index

```
src/App.jsx                         Root component
src/engine/fetcher.js               Yahoo OHLCV + fallback chain
src/engine/zerodhaFetcher.js        Zerodha Kite adapter
src/engine/dhanFetcher.js           Dhan HQ adapter
src/engine/dhanInstruments.js       Client-side Dhan scrip master cache
src/engine/dataSourceFetch.js       Data source switch
src/engine/patterns-scalp.js        SCALP — single "Strong Momo Pullback" pattern (rule #8)
src/engine/risk-scalp.js            SCALP — risk scoring + Wave 2a SL/target
src/engine/patterns-v2.js           INTRADAY — multi-pattern + Intraday Momentum Runner (PR #211)
src/engine/risk-v2.js               INTRADAY — risk scoring + INTRADAY_REGIME_STOPS_DEFAULTS
src/engine/patterns-classic.js      DELIVERY — daily-bar swing patterns
src/engine/risk-classic.js          DELIVERY — daily risk scoring
src/engine/tradeDecision.js         Filter / regime gate / rank / size + sizingTier (Wave 3)
src/engine/marketContext.js         Multi-factor layer classifiers + composer
src/engine/sectorMap.js             NSE sector mapping (208 stocks)
src/engine/indexDirection.js        NIFTY pre-window direction calc
src/engine/batchScan.js             Throttled multi-stock scanner + telemetry
src/engine/simulateDay.js           Bar-by-bar browser simulation
src/engine/proximity-scalp.js       Forming-signal classifier (Novice Mode tiers)
src/data/signalCategories.js        Engine-aware category resolvers + normalizeEngine()
scripts/simulate-day.mjs            CLI simulation (primary backtest tool)
scripts/walk-forward.mjs            Parallel walk-forward harness (--timeframe, --size-tiers)
scripts/replay-reference-trades.mjs Phase 0.5 gate — replay 8 peer trades (≥6/8 must fire)
worker/index.js                     Cloudflare Worker proxy
docs/AGENTS.md                      Deep architecture guide (the AI agent spec)
docs/INTEGRATIONS.md                All external integrations inventory
docs/GIT_WORKFLOW.md                Branching / merge / tag / release rules
docs/WORKER_OPS.md                  Worker deploy / rotate / troubleshooting
docs/ZERODHA_SETUP.md               User-facing Zerodha credential setup
```

---

## When in doubt

Read `docs/AGENTS.md` for detailed architecture. Read `docs/INTEGRATIONS.md` before adding any new external data source. Read `docs/GIT_WORKFLOW.md` before your first commit.
