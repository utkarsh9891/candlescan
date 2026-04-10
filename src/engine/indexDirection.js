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
    if (!candles?.length || candles.length < 15) {
      return { direction: 'neutral', strength: 0 };
    }

    // Use only candles up to "now" — current bar AND the opening move.
    // We measure direction as the net move from market open → current bar.
    // This matches what a trader sees intraday: "is the market up or down today?"
    const IST_OFFSET = 19800;
    const today = candles.filter(c => {
      const d = new Date((c.t + IST_OFFSET) * 1000);
      return d.getUTCHours() >= 9; // today's session from 09:15 IST onwards
    });
    if (today.length < 15) {
      return { direction: 'neutral', strength: 0 };
    }

    const first = today[0];
    const last = today[today.length - 1];
    const move = (last.c - first.o) / first.o;
    const absMove = Math.abs(move);

    let direction = 'neutral';
    let strength = 0;
    if (move > 0.0015) {
      direction = 'bullish';
      strength = Math.min(1, absMove * 100);
    } else if (move < -0.0015) {
      direction = 'bearish';
      strength = Math.min(1, absMove * 100);
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
