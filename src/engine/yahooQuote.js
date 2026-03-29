/**
 * Yahoo v7 quote (bid/ask where available) — uses centralized CF proxy.
 */
import { CF_WORKER_URL } from './fetcher.js';

function quoteUrl(symbols) {
  return `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}`;
}

/**
 * @param {string} yahooSymbol e.g. RELIANCE.NS
 * @returns {Promise<object|null>}
 */
export async function fetchYahooQuote(yahooSymbol) {
  if (!yahooSymbol || !CF_WORKER_URL) return null;
  try {
    const { cfFetch } = await import('../utils/cfProxy.js');
    const res = await cfFetch(quoteUrl(yahooSymbol));
    if (!res.ok) return null;
    const j = await res.json();
    const q = j?.quoteResponse?.result?.[0];
    if (!q) return null;
    return {
      symbol: q.symbol,
      shortName: q.shortName,
      bid: q.bid != null ? q.bid : null,
      ask: q.ask != null ? q.ask : null,
      bidSize: q.bidSize,
      askSize: q.askSize,
      last: q.regularMarketPrice,
      dayHigh: q.regularMarketDayHigh,
      dayLow: q.regularMarketDayLow,
      prevClose: q.regularMarketPreviousClose,
    };
  } catch {
    return null;
  }
}
