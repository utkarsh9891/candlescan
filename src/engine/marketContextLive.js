/**
 * Live market context fetchers.
 *
 * Counterpart to scripts/warm-news.mjs (which populates cache/ for
 * backtest use). This module fetches the same three data layers in
 * real time for live scanning in the browser, via the CF Worker proxy
 * (NSE + Moneycontrol + Yahoo are all CORS-blocked from the browser).
 *
 * Layers fetched here:
 *   1. India VIX close → regime classification
 *   2. FII/DII net values → institutional flow classification
 *   3. Moneycontrol news items → parsed + scored client-side into
 *      a symbol → sentiment map
 *
 * Called once at scan start from BatchScanPage / PaperTradingPage.
 * Each layer can fail independently — missing data becomes null and
 * the trade decision flow handles null gracefully.
 */

import { vixRegime, classifyInstitutionalFlow, classifyNewsSentiment } from './marketContext.js';
import { scoreText, parseRssItems, extractSymbols } from './newsSentiment.js';

const CF_WORKER_URL = 'https://candlescan-proxy.utkarsh-dev.workers.dev';

/** In-memory cache keyed by ISO date; cleared on manual refresh. */
const cache = { date: null, data: null };

/**
 * Fetch live India VIX close and classify.
 * @returns {Promise<{vix: number|null, regime: string|null}>}
 */
export async function fetchLiveVix() {
  try {
    const res = await fetch(`${CF_WORKER_URL}/market/vix`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { vix: null, regime: null };
    const data = await res.json();
    const vix = Number.isFinite(data.vix) ? data.vix : null;
    return { vix, regime: vixRegime(vix) };
  } catch {
    return { vix: null, regime: null };
  }
}

/**
 * Fetch live FII/DII net values and classify.
 * @returns {Promise<{fii: number|null, dii: number|null, flow: string|null}>}
 */
export async function fetchLiveFiiDii() {
  try {
    const res = await fetch(`${CF_WORKER_URL}/market/fiidii`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { fii: null, dii: null, flow: null };
    const data = await res.json();
    return {
      fii: data.fii,
      dii: data.dii,
      flow: classifyInstitutionalFlow(data.fii, data.dii),
    };
  } catch {
    return { fii: null, dii: null, flow: null };
  }
}

/**
 * Fetch Moneycontrol news items and score them against a symbol universe.
 * @param {Set<string>} symbolUniverse  uppercase NSE symbols to match
 * @returns {Promise<Record<string, number>>}  symbol → score in [-1, 1]
 */
export async function fetchLiveNews(symbolUniverse) {
  try {
    const res = await fetch(`${CF_WORKER_URL}/news/moneycontrol`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return {};
    const data = await res.json();
    const items = data.items || [];
    const perSymbol = {};
    for (const item of items) {
      const text = `${item.title || ''} ${item.description || ''}`;
      const symbols = extractSymbols(text, symbolUniverse);
      if (!symbols.length) continue;
      const score = scoreText(text);
      for (const sym of symbols) {
        if (!perSymbol[sym]) perSymbol[sym] = [];
        perSymbol[sym].push(score);
      }
    }
    // Average scores per symbol
    const out = {};
    for (const [sym, scores] of Object.entries(perSymbol)) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      out[sym] = Math.max(-1, Math.min(1, avg));
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Build the full live market context for a scan.
 * All three layers are fetched in parallel; each fails independently.
 *
 * @param {Set<string>} symbolUniverse
 * @returns {Promise<{
 *   vixRegime: string|null,
 *   flow: string|null,
 *   newsMap: Record<string, number>,
 *   vix: number|null,
 *   fii: number|null,
 *   dii: number|null,
 *   newsCount: number,
 *   fetchedAt: string,
 * }>}
 */
export async function fetchLiveMarketContext(symbolUniverse) {
  const today = new Date().toISOString().slice(0, 10);
  if (cache.date === today && cache.data) return cache.data;

  const [vixRes, flowRes, newsMap] = await Promise.all([
    fetchLiveVix(),
    fetchLiveFiiDii(),
    fetchLiveNews(symbolUniverse || new Set()),
  ]);

  const result = {
    vixRegime: vixRes.regime,
    flow: flowRes.flow,
    newsMap,
    vix: vixRes.vix,
    fii: flowRes.fii,
    dii: flowRes.dii,
    newsCount: Object.keys(newsMap).length,
    fetchedAt: new Date().toISOString(),
  };
  cache.date = today;
  cache.data = result;
  return result;
}

/** Clear the in-memory cache; next call will refetch. */
export function clearMarketContextCache() {
  cache.date = null;
  cache.data = null;
}

/**
 * Per-stock sentiment classification for use by the rank/gate phases.
 * Caller passes the news map from fetchLiveMarketContext and a symbol.
 * @param {Record<string, number>} newsMap
 * @param {string} symbol
 * @returns {string | null}
 */
export function getSymbolNewsSentiment(newsMap, symbol) {
  if (!newsMap || !symbol) return null;
  const clean = String(symbol).toUpperCase().replace(/\.NS$/, '');
  const score = newsMap[clean];
  if (score == null) return null;
  return classifyNewsSentiment(score);
}
