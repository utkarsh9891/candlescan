/**
 * Browser-compatible bar-by-bar trading simulation.
 * Zero lookahead: at bar T, only candles[0..T] are visible.
 * Engine-agnostic: accepts v1 or v2 engine functions as parameters.
 */

import { fetchOHLCV } from './fetcher.js';
import { fetchNseIndexSymbolList } from './nseIndexFetch.js';
import { MARGIN_MULTIPLIER } from '../data/marginData.js';
import { filterStock, regimeGate, rankScore, sizeMultiplier } from './tradeDecision.js';
import { classifyGap, liquidityTier } from './marketContext.js';

const IST_OFFSET = 19800; // +5:30 in seconds
const ACTIONABLE = new Set(['STRONG BUY', 'BUY', 'STRONG SHORT', 'SHORT']);
// Pessimistic-fill slippage: 0.03% per side, applied to entry and exit.
// Roughly one tick on a Rs 1000 stock. Combined with TX_COST_PCT this makes
// backtests match live fills more honestly — real orders rarely hit the
// exact SL/target price. Gated by pessimisticFills (default ON).
const SLIPPAGE_PCT = 0.0003;

/** Last IST trading day (skips weekends; before 3:30 PM uses previous day). */
/** Returns today if past 12 noon IST (trading data available), else last trading day. */
export function getSimulationDate() {
  const now = new Date();
  const istMs = now.getTime() + (now.getTimezoneOffset() * 60000) + (IST_OFFSET * 1000);
  const d = new Date(istMs);

  // If past noon on a weekday, use today (morning session data is available)
  if (d.getHours() >= 12 && d.getDay() !== 0 && d.getDay() !== 6) {
    return d.toISOString().slice(0, 10);
  }

  // Otherwise go back to last trading day
  if (d.getHours() < 12) d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

// Keep old name as alias for backward compat
export const getLastTradingDay = getSimulationDate;

/** Convert candle timestamp to IST date string. */
function istDate(t) {
  return new Date((t + IST_OFFSET) * 1000).toISOString().slice(0, 10);
}

/** Convert candle timestamp to IST HH:MM. */
function istTime(t) {
  const d = new Date((t + IST_OFFSET) * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** Parse "HH:MM" to seconds since midnight. */
function timeToSecs(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 3600 + m * 60;
}

/**
 * @param {Object} params
 * @param {string} params.indexName — e.g. 'NIFTY 50'
 * @param {string} params.timeframe — e.g. '5m'
 * @param {string} params.date — 'YYYY-MM-DD'
 * @param {string} params.startTime — 'HH:MM' IST
 * @param {string} params.endTime — 'HH:MM' IST
 * @param {{ detectPatterns: Function, detectLiquidityBox: Function, computeRiskScore: Function }} params.engineFns
 * @param {number} [params.capital=500000]
 * @param {number} [params.positionSize=100000]
 * @param {number} [params.maxConcurrent=3]
 * @param {number} [params.maxTotalTrades=6]
 * @param {number} [params.txCostPct=0.0002] — 0.02% per side, 0.04% round-trip (premium broker default)
 * @param {number} [params.minConfidence=75]
 * @param {number} [params.skipFirstBars=3]
 * @param {number} [params.minAvgVolume=50000]
 * @param {string} [params.gateToken]
 * @param {(phase: string, completed: number, total: number, current: string) => void} [params.onProgress]
 * @param {AbortSignal} [params.signal]
 */
export async function runSimulation({
  indexName,
  timeframe = '5m',
  date,
  startTime = '09:15',
  endTime = '10:30',
  engineFns,
  capital = 300000,
  positionSize = 300000,
  maxConcurrent = 1,
  maxTotalTrades = 5,
  txCostPct = 0.0002,
  minConfidence = 80,
  skipFirstBars = 0,
  minAvgVolume = 0,
  indexDirection,
  margin = false,
  marginMap = null,
  gateToken,
  batchToken, // backward compat
  onProgress,
  signal,
  fetchFn, // optional custom fetch (e.g. Dhan/Zerodha)
  pessimisticFills: pessimisticFillsOpt,
  useFlow: useFlowOpt,
}) {
  // Default ON: entry/exit slippage + probabilistic intra-bar straddle heuristic.
  // Callers can opt-out by passing pessimisticFills: false (legacy optimistic fills).
  const pessimisticFills = pessimisticFillsOpt !== false;
  // useFlow: FII/DII flow-alignment sizing (P1 #6). Default ON. Browser
  // marketCtx currently has flow=null (see docs/AGENTS.md "UI sim parity"),
  // so the delta is zero in the UI until live FII/DII wiring lands — the
  // toggle is here for symmetry with the CLI and for future live use.
  const useFlow = useFlowOpt !== false;
  const { detectPatterns, detectLiquidityBox, computeRiskScore } = engineFns;
  const startSecs = timeToSecs(startTime);
  const endSecs = timeToSecs(endTime);

  // Phase 1: Load index constituents
  onProgress?.('Loading index', 0, 1, indexName);
  if (signal?.aborted) return empty();
  const symbols = await fetchNseIndexSymbolList(indexName);
  if (!symbols?.length) throw new Error('Could not load index constituents');

  // Phase 2: Load candle data (throttled)
  const stockData = {};
  let loaded = 0;
  const total = symbols.length;
  const concurrency = 5;
  const delayMs = 200;

  for (let i = 0; i < total; i += concurrency) {
    if (signal?.aborted) break;
    const chunk = symbols.slice(i, i + concurrency);
    await Promise.allSettled(chunk.map(async (sym) => {
      if (signal?.aborted) return;
      try {
        const doFetch = fetchFn || fetchOHLCV;
        const result = await doFetch(sym, timeframe, { gateToken: gateToken || batchToken, date });
        const allCandles = result.candles;
        if (!allCandles?.length) return;

        // Filter to target date
        const dayCandles = allCandles.filter(c => istDate(c.t) === date);
        if (dayCandles.length < 5) return;

        // Filter to time window
        const windowCandles = dayCandles.filter(c => {
          const s = timeToSecs(istTime(c.t));
          return s >= startSecs && s <= endSecs;
        });
        if (windowCandles.length < 3) return;

        // Compute avg volume (filtering done after loading via auto-detect)
        const avgVol = windowCandles.reduce((s, c) => s + c.v, 0) / windowCandles.length;

        // Prior candles for pattern lookback
        const dayStart = allCandles.indexOf(dayCandles[0]);
        const priorCandles = allCandles.slice(Math.max(0, dayStart - 20), dayStart);

        // Previous day high/low for pattern context
        const prevCandles = allCandles.filter(c => istDate(c.t) < date);
        const prevDayHigh = prevCandles.length ? Math.max(...prevCandles.map(c => c.h)) : null;
        const prevDayLow = prevCandles.length ? Math.min(...prevCandles.map(c => c.l)) : null;

        // Opening Range (first 15 bars of the day = 9:15-9:30 on 1m)
        const orbBars = dayCandles.slice(0, 15);
        const orbHigh = orbBars.length >= 5 ? Math.max(...orbBars.map(c => c.h)) : null;
        const orbLow = orbBars.length >= 5 ? Math.min(...orbBars.map(c => c.l)) : null;

        // Pre-window candles (09:15 to window start) for pattern lookback context
        const preWindowCandles = dayCandles.filter(c => {
          const s = timeToSecs(istTime(c.t));
          return s >= timeToSecs('09:15') && s < startSecs;
        });

        // Map window candles to their index within dayCandles for bar tracking
        const firstWindowIdx = dayCandles.indexOf(windowCandles[0]);

        stockData[sym] = { dayCandles, priorCandles, preWindowCandles, windowCandles, firstWindowIdx, avgVol, prevDayHigh, prevDayLow, orbHigh, orbLow };
      } catch { /* skip */ }
    }));
    loaded = Math.min(total, i + concurrency);
    onProgress?.('Loading data', loaded, total, chunk[chunk.length - 1] || '');
    if (i + concurrency < total && delayMs > 0 && !signal?.aborted) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  const stockCount = Object.keys(stockData).length;
  if (!stockCount) {
    throw new Error(`No trading data found for ${date}. This date may be a market holiday, or the data is older than 5 trading days. Try a more recent trading day.`);
  }

  // Auto-detect volume threshold: 25th percentile (same as CLI)
  const allVols = Object.values(stockData).map(d => d.avgVol).sort((a, b) => a - b);
  if (allVols.length > 0) {
    const volThreshold = allVols[Math.floor(allVols.length * 0.25)] || 0;
    for (const sym of Object.keys(stockData)) {
      if (stockData[sym].avgVol < volThreshold) delete stockData[sym];
    }
  }
  const stockCount2 = Object.keys(stockData).length;

  // Phase 3: Bar-by-bar simulation
  const trades = [];
  const openPositions = [];
  // Per-symbol blacklist: once a symbol has been traded (any exit reason), don't
  // re-enter same day. This prevents re-chasing failed setups on the same stock
  // and the classic "double-down" gambler's fallacy where the same breakdown
  // pattern fires again 20 minutes later on a stock that already failed.
  const tradedSymbols = new Set();
  let currentCapital = capital;
  let peakCapital = capital;
  let maxDrawdown = 0;
  let totalTradesOpened = 0;
  // Running loss streak — resets on a win, increments on loss/breakeven.
  // Feeds sizeMultiplier so entries after 2+ losses size down (0.75/0.5).
  let consecutiveLosses = 0;

  const maxBars = Math.max(...Object.values(stockData).map(d => d.windowCandles.length));

  for (let barIdx = 0; barIdx < maxBars; barIdx++) {
    if (signal?.aborted) break;
    onProgress?.('Simulating', barIdx + 1, maxBars, `bar ${barIdx + 1}/${maxBars}`);

    // Check existing positions for SL/target/EOD
    for (let p = openPositions.length - 1; p >= 0; p--) {
      const pos = openPositions[p];
      const sd = stockData[pos.sym];
      if (barIdx >= sd.windowCandles.length) continue;
      const bar = sd.windowCandles[barIdx];

      let exitPrice = null;
      let exitReason = null;

      // Intra-bar straddle heuristic: when both SL and target are touched
      // within the same bar, bar direction (open→close) is a probabilistic
      // proxy for which barrier was struck first. Bearish bar → SL hit
      // first on a long; bullish bar → target hit first. Without pessimistic
      // fills the legacy behaviour is SL-first always (classic conservative).
      if (pos.direction === 'long') {
        const slHit = bar.l <= pos.sl;
        const tgtHit = bar.h >= pos.target;
        if (slHit && tgtHit) {
          if (pessimisticFills && bar.c >= bar.o) {
            exitPrice = pos.target; exitReason = 'TARGET';
          } else {
            exitPrice = pos.sl; exitReason = 'SL';
          }
        } else if (slHit) {
          exitPrice = pos.sl; exitReason = 'SL';
        } else if (tgtHit) {
          exitPrice = pos.target; exitReason = 'TARGET';
        }
      } else {
        const slHit = bar.h >= pos.sl;
        const tgtHit = bar.l <= pos.target;
        if (slHit && tgtHit) {
          if (pessimisticFills && bar.c <= bar.o) {
            exitPrice = pos.target; exitReason = 'TARGET';
          } else {
            exitPrice = pos.sl; exitReason = 'SL';
          }
        } else if (slHit) {
          exitPrice = pos.sl; exitReason = 'SL';
        } else if (tgtHit) {
          exitPrice = pos.target; exitReason = 'TARGET';
        }
      }

      // Time-based exit: maxHoldBars exceeded (scalping mode)
      if (!exitPrice && pos.maxHoldBars && (barIdx - pos.entryBar) >= pos.maxHoldBars) {
        exitPrice = bar.c;
        exitReason = 'TIME';
      }

      // EOD exit on last bar of window
      if (!exitPrice && barIdx === sd.windowCandles.length - 1) {
        exitPrice = bar.c;
        exitReason = 'EOD';
      }

      if (exitPrice) {
        // Apply exit slippage: sell (long exit) goes lower, buy-to-cover (short exit) goes higher.
        if (pessimisticFills) {
          exitPrice = pos.direction === 'long'
            ? exitPrice * (1 - SLIPPAGE_PCT)
            : exitPrice * (1 + SLIPPAGE_PCT);
        }
        const grossPnl = pos.direction === 'long'
          ? (exitPrice - pos.entry) * pos.shares
          : (pos.entry - exitPrice) * pos.shares;
        const txCost = (pos.entry * pos.shares + exitPrice * pos.shares) * txCostPct;
        const netPnl = grossPnl - txCost;

        currentCapital += netPnl;
        peakCapital = Math.max(peakCapital, currentCapital);
        maxDrawdown = Math.max(maxDrawdown, peakCapital - currentCapital);

        trades.push({
          sym: pos.sym, direction: pos.direction,
          entry: pos.entry, exit: exitPrice, shares: pos.shares,
          grossPnl, txCost, netPnl, reason: exitReason,
          entryTime: istTime(sd.windowCandles[pos.entryBar].t),
          exitTime: istTime(bar.t),
          confidence: pos.confidence, action: pos.action, pattern: pos.pattern,
          maxHoldBars: pos.maxHoldBars || null,
          sizeMult: pos.sizeMult ?? null,
          // Gate-level attribution — objects (never undefined). When a
          // signal had no feature payload (e.g. noTrade path), features
          // is null here; contextSnapshot is always an object.
          features: pos.features || null,
          contextSnapshot: pos.contextSnapshot || {
            vixRegime: null, gap: null, liquidity: null, flow: null,
            sentiment: null, sizeMult: pos.sizeMult ?? null,
            consecutiveLosses: null,
          },
        });
        if (netPnl > 0) consecutiveLosses = 0;
        else consecutiveLosses++;
        openPositions.splice(p, 1);
        tradedSymbols.add(pos.sym); // blacklist for rest of day
      }
    }

    // Skip first N bars (cool-off period)
    if (barIdx < skipFirstBars) continue;
    // Hard cap on total trades
    if (totalTradesOpened >= maxTotalTrades) continue;
    if (openPositions.length >= maxConcurrent) continue;

    // Collect all qualifying signals at this bar, then pick best by confidence
    const candidates = [];
    for (const sym of Object.keys(stockData)) {
      if (signal?.aborted) break;
      if (openPositions.some(p => p.sym === sym)) continue;
      if (tradedSymbols.has(sym)) continue; // already traded today — blacklisted

      const sd = stockData[sym];
      if (barIdx >= sd.windowCandles.length) continue;

      // Build candle array: prior + pre-window + day candles up to current bar (NO LOOKAHEAD)
      const dayBarIdx = sd.firstWindowIdx + barIdx;
      const preWindow = sd.preWindowCandles || [];
      const candlesSoFar = [...sd.priorCandles, ...preWindow, ...sd.dayCandles.slice(0, dayBarIdx + 1)];
      if (candlesSoFar.length < 10) continue;

      // Compute index intraday % at the current bar (no lookahead)
      const curTs = candlesSoFar[candlesSoFar.length - 1].t;
      let indexAtBar = indexDirection;
      if (indexDirection?.candles?.length && indexDirection.dayOpen != null) {
        let niftyCur = null;
        for (let k = indexDirection.candles.length - 1; k >= 0; k--) {
          if (indexDirection.candles[k].t <= curTs) { niftyCur = indexDirection.candles[k]; break; }
        }
        const niftyIntraPct = niftyCur ? (niftyCur.c - indexDirection.dayOpen) / indexDirection.dayOpen : 0;
        indexAtBar = { ...indexDirection, intradayPct: niftyIntraPct };
      }

      // Explicit stock day open for pattern/risk engines (no lookahead — it's
      // the 9:15 candle that's strictly in the past by the time we're here)
      const stockDayOpen = sd.dayCandles?.[0]?.o || null;

      const patterns = detectPatterns(candlesSoFar, {
        barIndex: barIdx,
        orbHigh: sd.orbHigh,
        orbLow: sd.orbLow,
        prevDayHigh: sd.prevDayHigh,
        prevDayLow: sd.prevDayLow,
        indexDirection: indexAtBar,
        stockDayOpen,
      });
      const box = detectLiquidityBox(candlesSoFar);
      const risk = computeRiskScore({ candles: candlesSoFar, patterns, box, opts: { barIndex: barIdx, indexDirection: indexAtBar, orbHigh: sd.orbHigh, orbLow: sd.orbLow, prevDayHigh: sd.prevDayHigh, prevDayLow: sd.prevDayLow, margin, marginMap, sym, stockDayOpen } });

      if (risk.confidence < minConfidence) continue;
      if (!ACTIONABLE.has(risk.action)) continue;

      // PHASE 2b: regime gate (post-pattern, day-level context)
      // Build the multi-factor market context from whatever the browser
      // sim has in scope. Day-level signals the browser cannot fetch
      // (VIX, FII/DII flow, per-stock news sentiment) stay as UNKNOWN
      // sentinels — the classifiers return neutral values for null
      // inputs so trade ranking is unchanged vs the pre-parity behavior.
      const prevClose = sd.priorCandles?.length ? sd.priorCandles[sd.priorCandles.length - 1].c : null;
      const gapClass = classifyGap(prevClose, stockDayOpen);
      const liqTier = liquidityTier(sd.avgVol);
      const marketCtx = {
        vixRegime: null,     // UNKNOWN: browser has no VIX feed
        gap: gapClass,
        liquidity: liqTier,
        flow: null,          // UNKNOWN: browser can't fetch FII/DII live
        sentiment: null,     // UNKNOWN: per-stock news not wired here yet
      };
      const gateRes = regimeGate(risk.direction, marketCtx);
      if (!gateRes.ok) continue;

      // PHASE 3a: rank score (per-stock signals only)
      const score = rankScore(risk, marketCtx);

      candidates.push({ sym, risk, patterns, score, marketCtx });
    }

    // PHASE 3b: sort by rank score, pick top N
    candidates.sort((a, b) => b.score - a.score);
    for (const c of candidates) {
      if (openPositions.length >= maxConcurrent) break;
      if (totalTradesOpened >= maxTotalTrades) break;

      // PHASE 4: position size multiplier (day-level signals control exposure)
      // Browser sim passes whatever day-level context it has (VIX / flow
      // are UNKNOWN so they're no-ops here); loss-streak protection works
      // regardless and is the primary sizing lever in the browser today.
      const sizeRes = sizeMultiplier({
        vixRegime: c.marketCtx?.vixRegime || null,
        flow: c.marketCtx?.flow || null,
        consecutiveLosses,
      }, { direction: c.risk.direction }, { useFlow });
      const basePosition = positionSize * sizeRes.mult;
      const effectivePositionSize = margin ? basePosition * MARGIN_MULTIPLIER : basePosition;
      // Apply entry slippage: buy (long) goes higher, sell-short (short) goes lower.
      const rawEntry = c.risk.entry;
      const entryPrice = pessimisticFills
        ? (c.risk.direction === 'long' ? rawEntry * (1 + SLIPPAGE_PCT) : rawEntry * (1 - SLIPPAGE_PCT))
        : rawEntry;
      const shares = Math.floor(effectivePositionSize / entryPrice);
      if (shares < 1) continue;

      openPositions.push({
        sym: c.sym, direction: c.risk.direction,
        entry: entryPrice, sl: c.risk.sl, target: c.risk.target,
        entryBar: barIdx, shares,
        confidence: c.risk.confidence, action: c.risk.action,
        pattern: c.patterns[0]?.name || 'None',
        maxHoldBars: c.risk.maxHoldBars || null,
        sizeMult: sizeRes.mult,
        // Gate-level attribution payload — persisted from entry to exit
        // so the emitted trade record can be joined back to the signal's
        // raw features and the day's market context at entry time.
        features: c.risk.features || null,
        contextSnapshot: {
          vixRegime: c.marketCtx?.vixRegime ?? null,
          gap: c.marketCtx?.gap ?? null,
          liquidity: c.marketCtx?.liquidity ?? null,
          flow: c.marketCtx?.flow ?? null,
          sentiment: c.marketCtx?.sentiment ?? null,
          sizeMult: sizeRes.mult,
          consecutiveLosses,
        },
      });
      totalTradesOpened++;
    }
  }

  // Summary
  const wins = trades.filter(t => t.netPnl > 0).length;
  const losses = trades.filter(t => t.netPnl <= 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const totalTxCost = trades.reduce((s, t) => s + t.txCost, 0);

  return {
    trades,
    summary: {
      date, stocksScanned: stockCount2 || stockCount,
      totalTrades: trades.length, wins, losses,
      winRate: trades.length ? (wins / trades.length * 100) : 0,
      totalPnl, totalTxCost, capital, finalCapital: currentCapital,
      maxDrawdown, returnPct: ((currentCapital - capital) / capital * 100),
    },
  };
}

function empty() {
  return {
    trades: [],
    summary: {
      date: '', stocksScanned: 0, totalTrades: 0, wins: 0, losses: 0,
      winRate: 0, totalPnl: 0, totalTxCost: 0, capital: 0, finalCapital: 0,
      maxDrawdown: 0, returnPct: 0,
    },
  };
}
