/**
 * Fetch parent index trend direction for scalping filter.
 * Called once per scan session, cached for 5 minutes.
 */

import { fetchOHLCV } from './fetcher.js';

/** Map index name to Yahoo symbol for the parent index. */
const INDEX_SYMBOL_MAP = {
  'NIFTY 50': '^NSEI',
  'NIFTY NEXT 50': '^NSEI',
  'NIFTY 100': '^NSEI',
  'NIFTY 200': '^NSEI',
  'NIFTY MIDCAP 50': 'NIFTY_MIDCAP_50.NS',
  'NIFTY MIDCAP 100': 'NIFTY_MIDCAP_50.NS',
  'NIFTY MIDCAP 150': 'NIFTY_MIDCAP_50.NS',
  'NIFTY SMALLCAP 50': 'NIFTY_SMLCAP_50.NS',
  'NIFTY SMALLCAP 100': 'NIFTY_SMLCAP_50.NS',
  'NIFTY SMALLCAP 250': 'NIFTY_SMLCAP_50.NS',
};

let cache = { indexName: null, result: null, ts: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function sma(vals, n) {
  if (vals.length < n) return null;
  const slice = vals.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/**
 * Get the parent index direction for a given index name.
 * @param {string} indexName — e.g. 'NIFTY SMALLCAP 100'
 * @param {string} [batchToken]
 * @returns {Promise<{ direction: 'bullish' | 'bearish' | 'neutral', strength: number }>}
 */
export async function getIndexDirection(indexName, batchToken) {
  // Return cache if fresh
  if (cache.indexName === indexName && Date.now() - cache.ts < CACHE_TTL && cache.result) {
    return cache.result;
  }

  const yahooSym = INDEX_SYMBOL_MAP[indexName] || '^NSEI'; // fallback to NIFTY

  try {
    const result = await fetchOHLCV(yahooSym, '1m', { batchToken });
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
        strength = Math.min(1, Math.abs(momentum) * 100); // normalize
      } else if (sma10 < sma20 && momentum < 0) {
        direction = 'bearish';
        strength = Math.min(1, Math.abs(momentum) * 100);
      } else {
        strength = Math.min(1, Math.abs(momentum) * 50);
      }
    }

    const res = { direction, strength };
    cache = { indexName, result: res, ts: Date.now() };
    return res;
  } catch {
    return { direction: 'neutral', strength: 0 };
  }
}

/** Clear the cache (e.g., on index change). */
export function clearIndexDirectionCache() {
  cache = { indexName: null, result: null, ts: 0 };
}
