/**
 * Fetch parent index trend direction for scalping filter.
 * Called once per scan session, cached for 5 minutes.
 * Cache key is the resolved Yahoo symbol, so indices sharing the
 * same parent (e.g., SMALLCAP 50/100/250 → ^NSMIDCP) don't re-fetch.
 */

import { fetchOHLCV } from './fetcher.js';

/** Map index name to Yahoo symbol for the parent index. */
const INDEX_SYMBOL_MAP = {
  'NIFTY 50': '^NSEI',
  'NIFTY NEXT 50': '^NSEI',
  'NIFTY 100': '^NSEI',
  'NIFTY 200': '^NSEI',
  'NIFTY 500': '^NSEI',
  'NIFTY MIDCAP 50': '^NSEI',
  'NIFTY MIDCAP 100': '^NSEI',
  'NIFTY MIDCAP 150': '^NSEI',
  'NIFTY SMALLCAP 50': '^NSEI',
  'NIFTY SMALLCAP 100': '^NSEI',
  'NIFTY SMALLCAP 250': '^NSEI',
};

let cache = { symbol: null, result: null, ts: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function sma(vals, n) {
  if (vals.length < n) return null;
  const slice = vals.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/**
 * Get the parent index direction for a given index name.
 * @param {string} indexName — e.g. 'NIFTY SMALLCAP 100'
 * @param {string} [gateToken]
 * @returns {Promise<{ direction: 'bullish' | 'bearish' | 'neutral', strength: number }>}
 */
export async function getIndexDirection(indexName, gateToken) {
  const yahooSym = INDEX_SYMBOL_MAP[indexName] || '^NSEI';

  // Return cache if fresh and same resolved symbol
  if (cache.symbol === yahooSym && Date.now() - cache.ts < CACHE_TTL && cache.result) {
    return cache.result;
  }

  try {
    const result = await fetchOHLCV(yahooSym, '1m', { gateToken });
    const candles = result.candles;
    if (!candles?.length || candles.length < 20) {
      return { direction: 'neutral', strength: 0 };
    }

    const closes = candles.map(c => c.c);
    const sma10 = sma(closes, 10);
    const sma20 = sma(closes, 20);

    // Last 5 bars momentum
    const last5 = candles.slice(-5);
    const momentum = (last5[last5.length - 1].c - last5[0].c) / last5[0].c;

    let direction = 'neutral';
    let strength = 0;

    if (sma10 != null && sma20 != null) {
      if (sma10 > sma20 && momentum > 0) {
        direction = 'bullish';
        strength = Math.min(1, Math.abs(momentum) * 100);
      } else if (sma10 < sma20 && momentum < 0) {
        direction = 'bearish';
        strength = Math.min(1, Math.abs(momentum) * 100);
      } else {
        strength = Math.min(1, Math.abs(momentum) * 50);
      }
    }

    const res = { direction, strength };
    cache = { symbol: yahooSym, result: res, ts: Date.now() };
    return res;
  } catch {
    return { direction: 'neutral', strength: 0 };
  }
}

/** Clear the cache (e.g., on index change). */
export function clearIndexDirectionCache() {
  cache = { symbol: null, result: null, ts: 0 };
}
