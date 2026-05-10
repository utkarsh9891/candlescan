/**
 * Last-trade quote fetch — proxies the worker's /quote/last endpoint
 * which wraps Yahoo's /v8/finance/chart (1m/1d) and extracts the most
 * recent candle close. Replaces the old /v7/finance/quote path which
 * Yahoo locked behind a crumb-cookie wall in 2025 (returns Unauthorized).
 *
 * Bid/ask are no longer available — /v8 doesn't carry them — so we
 * preserve the legacy {bid: null, ask: null, last, ...} response shape
 * and the UI gracefully shows last-trade price when bid/ask is missing.
 *
 * The worker caches per-symbol responses for 30s (`quoteLastKey` bucket),
 * so PaperTradingPage refreshing every 5s for K active trades collapses
 * to one upstream Yahoo call per symbol per cache window.
 */
import { CF_WORKER_URL } from './transport.js';

/**
 * @param {string} yahooSymbol e.g. RELIANCE.NS
 * @returns {Promise<object|null>}
 */
export async function fetchYahooQuote(yahooSymbol) {
  if (!yahooSymbol || !CF_WORKER_URL) return null;
  const clean = String(yahooSymbol).toUpperCase().replace(/\.NS$/, '');
  try {
    const res = await fetch(`${CF_WORKER_URL}/quote/last?symbol=${encodeURIComponent(clean)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const q = await res.json();
    if (!q || q.last == null) return null;
    return {
      symbol: clean,
      shortName: clean,
      bid: null,
      ask: null,
      bidSize: null,
      askSize: null,
      last: q.last,
      dayHigh: q.dayHigh ?? null,
      dayLow: q.dayLow ?? null,
      prevClose: q.prevClose ?? null,
    };
  } catch {
    return null;
  }
}
