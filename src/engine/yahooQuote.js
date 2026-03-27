/**
 * Yahoo v7 quote (bid/ask where available) — same Cloudflare proxy as chart fetcher.
 */
import { CF_WORKER_URL } from './fetcher.js';

function quoteUrl(symbols) {
  const q = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}`;
  return q;
}

/**
 * @param {string} yahooSymbol e.g. RELIANCE.NS
 * @returns {Promise<object|null>}
 */
export async function fetchYahooQuote(yahooSymbol) {
  if (!yahooSymbol || !CF_WORKER_URL) return null;
  try {
    const target = quoteUrl(yahooSymbol);
    const proxy = `${CF_WORKER_URL}?url=${encodeURIComponent(target)}`;
    const res = await fetch(proxy, { cache: 'no-store' });
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
