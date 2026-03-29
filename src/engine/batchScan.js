/**
 * Batch scan — scans all stocks in an index with throttled concurrency.
 * Reuses fetchOHLCV, detectPatterns, detectLiquidityBox, computeRiskScore.
 */

import { fetchOHLCV } from './fetcher.js';
import { detectPatterns } from './patterns.js';
import { detectLiquidityBox } from './liquidityBox.js';
import { computeRiskScore } from './risk.js';

const ACTION_RANK = {
  'STRONG BUY': 5,
  'STRONG SHORT': 5,
  BUY: 4,
  SHORT: 4,
  WAIT: 2,
  'NO TRADE': 0,
};

/**
 * @param {Object} params
 * @param {string[]} params.symbols — list of NSE symbols (without .NS)
 * @param {string}   params.timeframe — e.g. '5m'
 * @param {string}   params.batchToken — passphrase for auth
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
  concurrency = 5,
  delayMs = 200,
  onProgress,
  signal,
}) {
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

          const patterns = detectPatterns(candles);
          const box = detectLiquidityBox(candles);
          const risk = computeRiskScore({ candles, patterns, box });

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
