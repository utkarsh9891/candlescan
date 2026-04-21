# CLAUDE.md

This file is auto-loaded by Claude Code at every session start. It contains the rules and context that must always be in effect when working in this repo.

**For deep architecture, engine internals, data flow, and history — see [`docs/AGENTS.md`](docs/AGENTS.md).** This file is intentionally short.

---

## Project identity

**CandleScan** — React 18 + Vite 6 PWA for NSE candlestick pattern scanning, scalp signal detection, and trading simulation. Deployed to GitHub Pages. Backend is a Cloudflare Worker that proxies Yahoo Finance, NSE, Zerodha Kite, and Dhan HQ. Plain JSX (no TypeScript), inline styles (no CSS files), React hooks only (no Redux).

---

## Non-negotiables (hard rules)

1. **Branch protection**: Never push directly to `main`. All work goes through a PR via `gh pr create` → `gh pr merge <n> --merge --delete-branch`. Merge method is `--merge` only — never `--squash` or `--rebase`.

2. **Version / tags**: **Do not create git tags manually.** CI auto-tags every merge to main — **patch** by default, or **minor/major when the PR carries the `release:minor` / `release:major` label at merge time** (apply the label *before* merging; applying it after has no effect). `package.json` has no `version` field — it comes from `git describe --tags` at build time via `vite.config.js`. See [`docs/GIT_WORKFLOW.md`](docs/GIT_WORKFLOW.md) for the full label flow.

3. **Tests and build before push**: Pre-push hook runs `npm test && npm run build`. Do not bypass with `--no-verify` unless the user explicitly asks.

4. **No ranking-shift layer bonuses, plus HIGH-VIX veto**: In `src/engine/marketContext.js`, positive confidence bonuses from day-level context layers (VIX, gap, liquidity, flow) are **kept at 0** by design. Bonuses shift candidate ranking and displace high-quality winners with marginally-boosted losers. Only news sentiment gets positive bonuses (it's the strongest predictive signal). Vetoes are fine — they just remove bad trades. A **HIGH-VIX regime veto** is active in `regimeGate` (validated via walk-forward 2026-04-21: HIGH-VIX trades had PF 1.01 vs 2.46 non-HIGH — empirically zero-edge). If tempted to add a bonus to any non-news layer, re-read the empirical sweep table in `docs/INTEGRATIONS.md`.

5. **No lookahead in simulations**: Every time-series lookup must use `t <= curTs`, not `t < curEnd` or full-day aggregates. Index direction uses pre-window move, NOT EOD. Sector intraday % uses the latest bar at or before the stock bar's timestamp. Audit any new time-series code for lookahead before shipping.

6. **5x margin is default** in the simulator. `shares = floor((positionSize × MARGIN_MULTIPLIER) / entry)`. Rs 3L capital controls Rs 15L exposure. P&L magnitudes are reported on the leveraged exposure, not raw capital.

7. **Premium broker tx cost**: `TX_COST_PCT = 0.0002` (0.02% per side, 0.04% round-trip = ~Rs 600 per trade on 15L). This matches the app owner's actual broker plan, not standard retail. Do not change this without an explicit user instruction.

8. **Single scalp strategy**: There is ONE pattern in `src/engine/patterns-scalp.js` — the "Strong Momo Pullback". Do not add additional patterns or variants. The entire fusion / boxTheory / quickFlip / touchAndTurn variant system was removed because firing many patterns produced many mediocre signals. One strict gate > seven permissive ones.

---

## Workflow commands

```bash
npm start            # dev server at 127.0.0.1:5173/candlescan/
npm test             # 223 unit tests (vitest)
npm run build        # production build → dist/
npm run simulate     # CLI simulation: node scripts/simulate-day.mjs
npm run cache:charts # warm local chart cache
```

CLI simulation is the primary tool for backtesting strategy changes. Default run matches the app owner's real trading params:

```bash
node scripts/simulate-day.mjs 1m \
  --index "NIFTY SMALLCAP 100" \
  --date 2026-04-10 \
  --engine scalp \
  --variant momentum \
  --confidence 75 \
  --max-positions 1 \
  --position-size 300000 \
  --max-trades 5
```

Any strategy change must be validated on the **17-day window Mar 12 - Apr 10 2026** before shipping. The full 17-day sweep takes ~3 minutes.

---

## Target & current state

**Target**: Rs 10,000+/day consistent on NIFTY SMALLCAP 100, 3L capital, 1 parallel, 5 max trades, 5x margin, 9:30-11:00 window.

**Current baseline** (Wave 2a — regime-aware stops default ON): **+Rs 37,530 over 17 days (Mar 12 – Apr 10 2026)** on the pessimistic-fills simulator, ~Rs 2,200/day avg. The Wave 2a tuning ships `REGIME_STOPS_DEFAULTS` in `src/engine/risk-scalp.js` as `NORMAL=1.5, LOW=1.2, RR=1.8, slFloor=0.005, slCap=0.012, targetCap=0.030`. The win vs legacy (+Rs 8,994) is emergent: at RR=1.8 the post-clamp rr falls below the hard 2.0 min-rr gate for wide-ATR bars, so those trades (previously wide-stop losers) get dropped upstream.

Prior baseline (Wave 1 — rs-threshold tuning, legacy SL/target): +Rs 28,537. Pre-Wave-1 pessimistic baseline: +Rs 22,639. Pre-pessimistic-fills optimistic baseline: +Rs 49,296 (PR #161 era).

Walk-forward harness (`scripts/walk-forward.mjs`) now defaults to `--regime-stops` ON; pass `--no-regime-stops` to A/B against the legacy 0.5%/1.0% path. Any strategy commit that regresses the 17-day net P&L below +Rs 19,000 (pessimistic-fills reference, pre-Wave-1) should be flagged and investigated before merging.

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
src/engine/patterns-scalp.js        Single "Strong Momo Pullback" pattern
src/engine/risk-scalp.js            Risk scoring + SL/target + multi-factor context
src/engine/marketContext.js         Multi-factor layer classifiers + composer
src/engine/sectorMap.js             NSE sector mapping (208 stocks)
src/engine/indexDirection.js        NIFTY pre-window direction calc
src/engine/batchScan.js             Throttled multi-stock scanner + telemetry
src/engine/simulateDay.js           Bar-by-bar browser simulation
scripts/simulate-day.mjs            CLI simulation (primary backtest tool)
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
