/**
 * Dynamic indices — live top gainers & losers from NSE.
 *
 * Endpoints (free, no auth, just needs User-Agent + Referer):
 *   Gainers: https://www.nseindia.com/api/live-analysis-variations?section=gainers&index=gainers
 *   Losers:  https://www.nseindia.com/api/live-analysis-variations?section=losers&index=losers
 *
 * Response structure:
 *   { NIFTY: { data: [...], timestamp }, BANKNIFTY: {...}, allSec: { data: [...] }, ... }
 *
 * We use the `allSec` section — top gainers/losers across ALL NSE securities,
 * not filtered to any specific index.
 */

export const DYNAMIC_INDEX_IDS = {
  TOP_GAINERS: 'TOP GAINERS (Live)',
  TOP_LOSERS: 'TOP LOSERS (Live)',
};

export function isDynamicIndex(indexId) {
  return Object.values(DYNAMIC_INDEX_IDS).includes(indexId);
}

const NSE_GAINERS_URL = 'https://www.nseindia.com/api/live-analysis-variations?section=gainers&index=gainers';
// Losers: no dedicated NSE endpoint — use NIFTY 500 index API, sort by pChange ascending
const NSE_NIFTY500_URL = 'https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20500';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Referer: 'https://www.nseindia.com/',
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes (data is live market)
const _cache = { gainers: null, losers: null, gainersTs: 0, losersTs: 0 };

/**
 * Fetch top gainers/losers symbols from NSE (browser).
 * Gainers: NSE live-analysis API (top movers across all sections).
 * Losers: NIFTY 500 index API sorted by pChange ascending (top 30 negative).
 * Uses CORS proxies as fallback (same pattern as nseIndexFetch.js).
 * @param {'TOP GAINERS (Live)' | 'TOP LOSERS (Live)'} indexId
 * @returns {Promise<string[]>} Array of NSE ticker symbols
 */
export async function fetchDynamicIndexSymbols(indexId) {
  const isGainers = indexId === DYNAMIC_INDEX_IDS.TOP_GAINERS;
  const cacheKey = isGainers ? 'gainers' : 'losers';
  const tsKey = isGainers ? 'gainersTs' : 'losersTs';

  if (_cache[cacheKey] && Date.now() - _cache[tsKey] < CACHE_TTL_MS) {
    return _cache[cacheKey];
  }

  let symbols;
  if (isGainers) {
    const data = await fetchWithFallbacks(NSE_GAINERS_URL);
    symbols = extractAllSecSymbols(data);
  } else {
    const data = await fetchWithFallbacks(NSE_NIFTY500_URL);
    symbols = extractTopLosers(data);
  }

  if (symbols.length > 0) {
    _cache[cacheKey] = symbols;
    _cache[tsKey] = Date.now();
  }

  return symbols;
}

/**
 * Fetch with CORS fallbacks (browser).
 * Same pattern as nseIndexFetch.js — try direct, then CF worker, then allorigins.
 */
async function fetchWithFallbacks(url) {
  // 1. Try dev proxy (Vite proxy rewrites /nse-api to nseindia.com)
  const proxyPath = url.replace('https://www.nseindia.com', '');
  try {
    const res = await fetch(`/nse-api${proxyPath}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return res.json();
  } catch { /* fallback */ }

  // 2. Try allorigins CORS proxy
  try {
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
    if (res.ok) return res.json();
  } catch { /* fallback */ }

  // 3. Try direct (may work in some environments)
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return res.json();
  } catch { /* failed */ }

  throw new Error(`Failed to fetch dynamic index from NSE`);
}

/**
 * Fetch dynamic index symbols from Node.js (scripts/CLI).
 * Direct fetch with proper headers (no CORS issues in Node).
 */
export async function fetchDynamicIndexSymbolsNode(indexId) {
  const isGainers = indexId === DYNAMIC_INDEX_IDS.TOP_GAINERS;
  const cacheKey = isGainers ? 'gainers' : 'losers';
  const tsKey = isGainers ? 'gainersTs' : 'losersTs';

  if (_cache[cacheKey] && Date.now() - _cache[tsKey] < CACHE_TTL_MS) {
    return _cache[cacheKey];
  }

  const url = isGainers ? NSE_GAINERS_URL : NSE_NIFTY500_URL;
  const res = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`NSE HTTP ${res.status}`);
  const data = await res.json();
  const symbols = isGainers ? extractAllSecSymbols(data) : extractTopLosers(data);

  if (symbols.length > 0) {
    _cache[cacheKey] = symbols;
    _cache[tsKey] = Date.now();
  }

  return symbols;
}

/**
 * Extract top losers from NIFTY 500 index API response.
 * Sorts by pChange ascending and returns top 30 with negative pChange.
 */
function extractTopLosers(data, count = 30) {
  if (!data?.data || !Array.isArray(data.data)) return [];
  const stocks = data.data
    .filter(s => s.symbol && s.series === 'EQ' && typeof s.pChange === 'number' && s.pChange < 0)
    .sort((a, b) => a.pChange - b.pChange) // most negative first
    .slice(0, count)
    .map(s => s.symbol);
  return stocks;
}

/**
 * Extract symbols from allSec section (all securities, not index-specific).
 * Falls back to combining NIFTY + BANKNIFTY + NIFTYNEXT50 if allSec is missing.
 */
function extractAllSecSymbols(data) {
  if (!data || typeof data !== 'object') return [];

  const symbols = new Set();

  // Primary: allSec (all securities across NSE)
  const allSec = data.allSec;
  if (allSec?.data && Array.isArray(allSec.data)) {
    for (const s of allSec.data) {
      if (s.symbol && s.series === 'EQ') symbols.add(s.symbol);
    }
  }

  // Also include NIFTY, BANKNIFTY, NIFTYNEXT50, FOSec, SecGtr20/SecLwr20
  for (const key of ['NIFTY', 'BANKNIFTY', 'NIFTYNEXT50', 'FOSec', 'SecGtr20', 'SecLwr20']) {
    const section = data[key];
    const entries = section?.data || (Array.isArray(section) ? section : []);
    for (const s of entries) {
      if (s.symbol && s.series === 'EQ') symbols.add(s.symbol);
    }
  }

  return [...symbols];
}
