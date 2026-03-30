/**
 * Browser-compatible bar-by-bar trading simulation.
 * Zero lookahead: at bar T, only candles[0..T] are visible.
 * Engine-agnostic: accepts v1 or v2 engine functions as parameters.
 */

import { fetchOHLCV } from './fetcher.js';
import { fetchNseIndexSymbolList } from './nseIndexFetch.js';

const IST_OFFSET = 19800; // +5:30 in seconds
const ACTIONABLE = new Set(['STRONG BUY', 'BUY', 'STRONG SHORT', 'SHORT']);

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
 * @param {number} [params.txCostPct=0.0005]
 * @param {number} [params.minConfidence=75]
 * @param {number} [params.skipFirstBars=3]
 * @param {number} [params.minAvgVolume=50000]
 * @param {string} [params.batchToken]
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
  txCostPct = 0.0005,
  minConfidence = 80,
  skipFirstBars = 4,
  minAvgVolume = 50000,
  batchToken,
  onProgress,
  signal,
}) {
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
        const result = await fetchOHLCV(sym, timeframe, { batchToken });
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

        // Check avg volume
        const avgVol = windowCandles.reduce((s, c) => s + c.v, 0) / windowCandles.length;
        if (avgVol < minAvgVolume) return;

        // Prior candles for pattern lookback
        const dayStart = allCandles.indexOf(dayCandles[0]);
        const priorCandles = allCandles.slice(Math.max(0, dayStart - 20), dayStart);

        // Map window candles to their index within dayCandles for bar tracking
        const firstWindowIdx = dayCandles.indexOf(windowCandles[0]);

        stockData[sym] = { dayCandles, priorCandles, windowCandles, firstWindowIdx, avgVol };
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

  // Phase 3: Bar-by-bar simulation
  const trades = [];
  const openPositions = [];
  let currentCapital = capital;
  let peakCapital = capital;
  let maxDrawdown = 0;
  let totalTradesOpened = 0;

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

      if (pos.direction === 'long') {
        if (bar.l <= pos.sl) { exitPrice = pos.sl; exitReason = 'SL'; }
        else if (bar.h >= pos.target) { exitPrice = pos.target; exitReason = 'TARGET'; }
      } else {
        if (bar.h >= pos.sl) { exitPrice = pos.sl; exitReason = 'SL'; }
        else if (bar.l <= pos.target) { exitPrice = pos.target; exitReason = 'TARGET'; }
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
        });
        openPositions.splice(p, 1);
      }
    }

    // Skip first N bars (cool-off period)
    if (barIdx < skipFirstBars) continue;
    // Hard cap on total trades
    if (totalTradesOpened >= maxTotalTrades) continue;
    if (openPositions.length >= maxConcurrent) continue;

    // Generate signals
    for (const sym of Object.keys(stockData)) {
      if (signal?.aborted) break;
      if (openPositions.length >= maxConcurrent) break;
      if (totalTradesOpened >= maxTotalTrades) break;
      if (openPositions.some(p => p.sym === sym)) continue;

      const sd = stockData[sym];
      if (barIdx >= sd.windowCandles.length) continue;

      // Build candle array: prior + day candles up to current bar (NO LOOKAHEAD)
      const dayBarIdx = sd.firstWindowIdx + barIdx;
      const candlesSoFar = [...sd.priorCandles, ...sd.dayCandles.slice(0, dayBarIdx + 1)];
      if (candlesSoFar.length < 10) continue;

      const patterns = detectPatterns(candlesSoFar, { barIndex: barIdx });
      const box = detectLiquidityBox(candlesSoFar);
      const risk = computeRiskScore({ candles: candlesSoFar, patterns, box, opts: { barIndex: barIdx } });

      if (risk.confidence < minConfidence) continue;
      if (!ACTIONABLE.has(risk.action)) continue;

      const shares = Math.floor(positionSize / risk.entry);
      if (shares < 1) continue;

      openPositions.push({
        sym, direction: risk.direction,
        entry: risk.entry, sl: risk.sl, target: risk.target,
        entryBar: barIdx, shares,
        confidence: risk.confidence, action: risk.action,
        pattern: patterns[0]?.name || 'None',
        maxHoldBars: risk.maxHoldBars || null,
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
      date, stocksScanned: stockCount,
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
