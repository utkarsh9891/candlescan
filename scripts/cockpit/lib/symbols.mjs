/**
 * Index symbol fetcher with per-IST-day cache.
 *
 * NSE's stock-indices API is the authoritative source for membership
 * (used by the live PWA + simulate-day.mjs). We cache the result for
 * the trading day so the scan loop only pays the NSE round-trip once
 * per day, not per scan tick.
 */

import { fetchNseIndexSymbolsNode } from '../../lib/nse-http.mjs';

const cache = { date: null, indexName: null, symbols: null };

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function todayIst() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * @param {string} indexName  e.g. "NIFTY 50"
 * @returns {Promise<string[]>}  array of NSE symbols (no suffix)
 */
export async function getIndexSymbols(indexName) {
  const today = todayIst();
  if (
    cache.date === today &&
    cache.indexName === indexName &&
    cache.symbols
  ) {
    return cache.symbols;
  }
  const symbols = await fetchNseIndexSymbolsNode(indexName);
  cache.date = today;
  cache.indexName = indexName;
  cache.symbols = symbols;
  return symbols;
}

export function _resetCache() {
  cache.date = null;
  cache.indexName = null;
  cache.symbols = null;
}
