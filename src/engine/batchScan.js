/**
 * Batch scan — scans all stocks in an index with throttled concurrency.
 * Engine-aware: accepts detectPatterns, detectLiquidityBox, computeRiskScore
 * as parameters so the caller can select scalp/v2/classic engine.
 * Computes ORB + prev day levels per stock for pattern context.
 */

import { fetchOHLCV } from './fetcher.js';
// Fallback imports (used when engineFns not provided)
import { detectPatterns as detectPatternsDefault } from './patterns.js';
import { detectLiquidityBox as detectLiquidityBoxDefault } from './liquidityBox.js';
import { computeRiskScore as computeRiskScoreDefault } from './risk.js';

const ACTION_RANK = {
  'STRONG BUY': 5,
  'STRONG SHORT': 5,
  BUY: 4,
  SHORT: 4,
  WAIT: 2,
  'NO TRADE': 0,
};

const IST_OFFSET = 19800; // +5:30 in seconds
function istDate(t) {
  return new Date((t + IST_OFFSET) * 1000).toISOString().slice(0, 10);
}

/**
 * @param {Object} params
 * @param {string[]} params.symbols — list of NSE symbols (without .NS)
 * @param {string}   params.timeframe — e.g. '5m'
 * @param {string}   params.batchToken — passphrase for auth
 * @param {{ detectPatterns: Function, detectLiquidityBox: Function, computeRiskScore: Function }} [params.engineFns]
 * @param {{ direction: string, strength: number }} [params.indexDirection]
 * @param {number}   [params.concurrency=5]
 * @param {number}   [params.delayMs=200]
 * @param {(completed: number, total: number, current: string) => void} [params.onProgress]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<Array>} sorted results
 */
export async function batchScan({
  symbols,
  timeframe,
  batchToken,
  engineFns,
  indexDirection,
  concurrency = 5,
  delayMs = 200,
  onProgress,
  signal,
}) {
  // Use provided engine functions or fall back to defaults
  const detectPatterns = engineFns?.detectPatterns || detectPatternsDefault;
  const detectLiquidityBox = engineFns?.detectLiquidityBox || detectLiquidityBoxDefault;
  const computeRiskScore = engineFns?.computeRiskScore || computeRiskScoreDefault;

  const results = [];
  let completed = 0;
  const total = symbols.length;

  for (let i = 0; i < total; i += concurrency) {
    if (signal?.aborted) break;

    const chunk = symbols.slice(i, i + concurrency);

    const settled = await Promise.allSettled(
      chunk.map(async (sym) => {
        if (signal?.aborted) return null;
        try {
          const result = await fetchOHLCV(sym, timeframe, { batchToken });
          const { candles, companyName, displaySymbol, error } = result;
          if (error || !candles?.length) return null;

          // Compute ORB + prev day levels for pattern context
          const lastDate = istDate(candles[candles.length - 1].t);
          const todayCandles = candles.filter(c => istDate(c.t) === lastDate);
          const prevCandles = candles.filter(c => istDate(c.t) < lastDate);

          const orbBars = todayCandles.slice(0, 15);
          const orbHigh = orbBars.length >= 5 ? Math.max(...orbBars.map(c => c.h)) : null;
          const orbLow = orbBars.length >= 5 ? Math.min(...orbBars.map(c => c.l)) : null;
          const prevDayHigh = prevCandles.length ? Math.max(...prevCandles.map(c => c.h)) : null;
          const prevDayLow = prevCandles.length ? Math.min(...prevCandles.map(c => c.l)) : null;

          const patterns = detectPatterns(candles, {
            orbHigh, orbLow, prevDayHigh, prevDayLow,
          });
          const box = detectLiquidityBox(candles);
          const risk = computeRiskScore({
            candles, patterns, box,
            opts: { barIndex: candles.length, indexDirection: indexDirection || null },
          });

          return {
            symbol: displaySymbol,
            companyName: companyName || displaySymbol,
            action: risk.action,
            confidence: risk.confidence,
            direction: risk.direction,
            level: risk.level,
            entry: risk.entry,
            sl: risk.sl,
            target: risk.target,
            rr: risk.rr,
            topPattern: patterns[0]?.name || 'None',
            context: risk.context,
          };
        } catch {
          return null;
        }
      })
    );

    for (const r of settled) {
      completed++;
      if (r.status === 'fulfilled' && r.value) {
        results.push(r.value);
      }
    }

    onProgress?.(completed, total, chunk[chunk.length - 1] || '');

    // Throttle between batches
    if (i + concurrency < total && delayMs > 0 && !signal?.aborted) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }

  // Sort: actionable first (by rank desc), then by confidence desc
  results.sort((a, b) => {
    const ra = ACTION_RANK[a.action] || 0;
    const rb = ACTION_RANK[b.action] || 0;
    if (ra !== rb) return rb - ra;
    return b.confidence - a.confidence;
  });

  return results;
}
