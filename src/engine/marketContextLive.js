/**
 * Live market context fetchers.
 *
 * Counterpart to scripts/warm-news.mjs (which populates cache/ for
 * backtest use). This module fetches the same three data layers in
 * real time for live scanning in the browser, via the CF Worker proxy
 * (NSE + the Indian news publishers are all CORS-blocked from the browser).
 *
 * Layers fetched here:
 *   1. India VIX close → regime classification
 *   2. FII/DII net values → institutional flow classification
 *   3. Broad Indian news items (Moneycontrol + LiveMint + Economic
 *      Times + Business Standard merged at the Worker) → parsed +
 *      scored client-side into a symbol → sentiment map
 *
 * Caching strategy — per layer, 10-minute TTL:
 *   - Previously a single day-keyed cache wrapped all three layers,
 *     which silently pinned VIX and news for the whole trading session.
 *     That defeated the Worker KV's own 1h/10-60m refresh cadence, so
 *     the HIGH-VIX regime veto missed intraday regime changes and
 *     breaking news was invisible until the next UTC midnight.
 *   - Now each layer has its own 10-min TTL matching the Worker's
 *     news market-hours cadence, with per-layer in-flight de-duplication
 *     so concurrent scans issue exactly one CF call.
 *   - News items are cached as raw items; the per-universe scoreMap
 *     and headlinesMap are recomputed on every call because scoring
 *     depends on which symbols are in the caller's universe — without
 *     this, switching indices mid-session would serve the first scan's
 *     score map to the second.
 */

import { vixRegime, classifyInstitutionalFlow, classifyNewsSentiment } from './marketContext.js';
import { scoreText, extractSymbols } from './newsSentiment.js';
import { CF_WORKER_URL } from './transport.js';

/**
 * 10 minutes — matches the Worker's broad-feed KV TTL during market
 * hours and VIX's regime-change cadence. Short enough that the HIGH-VIX
 * veto sees real regime shifts; long enough to de-dup rapid re-scans.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;

const vixCache = { vix: null, regime: null, fetchedAt: 0 };
let vixInflight = null;

const flowCache = { fii: null, dii: null, flow: null, fetchedAt: 0 };
let flowInflight = null;

/** Raw news items (not scored). Scoring is per-universe and done per call. */
const newsItemsCache = { items: null, fetchedAt: 0 };
let newsItemsInflight = null;

function isFresh(entry) {
  return entry.fetchedAt > 0 && Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

/**
 * Fetch live India VIX close and classify.
 * @returns {Promise<{vix: number|null, regime: string|null}>}
 */
export async function fetchLiveVix() {
  if (isFresh(vixCache)) return { vix: vixCache.vix, regime: vixCache.regime };
  if (vixInflight) return vixInflight;
  vixInflight = (async () => {
    try {
      const res = await fetch(`${CF_WORKER_URL}/market/vix`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return { vix: null, regime: null };
      const data = await res.json();
      const vix = Number.isFinite(data.vix) ? data.vix : null;
      const regime = vixRegime(vix);
      vixCache.vix = vix;
      vixCache.regime = regime;
      vixCache.fetchedAt = Date.now();
      return { vix, regime };
    } catch {
      return { vix: null, regime: null };
    } finally {
      vixInflight = null;
    }
  })();
  return vixInflight;
}

/**
 * Fetch live FII/DII net values and classify.
 * @returns {Promise<{fii: number|null, dii: number|null, flow: string|null}>}
 */
export async function fetchLiveFiiDii() {
  if (isFresh(flowCache)) {
    return { fii: flowCache.fii, dii: flowCache.dii, flow: flowCache.flow };
  }
  if (flowInflight) return flowInflight;
  flowInflight = (async () => {
    try {
      const res = await fetch(`${CF_WORKER_URL}/market/fiidii`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return { fii: null, dii: null, flow: null };
      const data = await res.json();
      const flow = classifyInstitutionalFlow(data.fii, data.dii);
      flowCache.fii = data.fii;
      flowCache.dii = data.dii;
      flowCache.flow = flow;
      flowCache.fetchedAt = Date.now();
      return { fii: data.fii, dii: data.dii, flow };
    } catch {
      return { fii: null, dii: null, flow: null };
    } finally {
      flowInflight = null;
    }
  })();
  return flowInflight;
}

/**
 * Fetch raw broad Indian news items from the Worker. Cached with a
 * 10-min TTL. Kept separate from scoring because scoring depends on
 * the caller's symbol universe and must be recomputed each call.
 *
 * The Worker merges multiple Indian publisher feeds (Moneycontrol,
 * LiveMint, Economic Times, Business Standard) into a single payload;
 * each item carries a `publisher` tag so we can attribute headlines
 * in the UI without a second round trip.
 *
 * @returns {Promise<Array<{title?: string, description?: string, link?: string, publisher?: string}>>}
 */
async function fetchRawIndianNewsItems() {
  if (isFresh(newsItemsCache)) return newsItemsCache.items || [];
  if (newsItemsInflight) return newsItemsInflight;
  newsItemsInflight = (async () => {
    try {
      const res = await fetch(`${CF_WORKER_URL}/news/india`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return [];
      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      newsItemsCache.items = items;
      newsItemsCache.fetchedAt = Date.now();
      return items;
    } catch {
      return [];
    } finally {
      newsItemsInflight = null;
    }
  })();
  return newsItemsInflight;
}

/**
 * Fetch broad Indian news items and score them against a symbol universe.
 * Returns BOTH the aggregated score map AND the individual headlines
 * per symbol so the UI can show WHY a stock has the sentiment it does.
 *
 * Scoring is always computed fresh against the provided universe — the
 * raw items are cached 10 min but the per-symbol map is not, so two
 * scans of different indices in the same session get correctly-scoped
 * score maps.
 *
 * @param {Set<string>} symbolUniverse  uppercase NSE symbols to match
 * @returns {Promise<{
 *   scoreMap: Record<string, number>,
 *   headlinesMap: Record<string, Array<{title, description, score, source, publisher}>>,
 * }>}
 */
export async function fetchLiveNews(symbolUniverse) {
  const items = await fetchRawIndianNewsItems();
  const perSymbolScores = {};
  const perSymbolHeadlines = {};
  for (const item of items) {
    const text = `${item.title || ''} ${item.description || ''}`;
    const symbols = extractSymbols(text, symbolUniverse);
    if (!symbols.length) continue;
    const score = scoreText(text);
    for (const sym of symbols) {
      if (!perSymbolScores[sym]) perSymbolScores[sym] = [];
      if (!perSymbolHeadlines[sym]) perSymbolHeadlines[sym] = [];
      perSymbolScores[sym].push(score);
      perSymbolHeadlines[sym].push({
        title: item.title,
        // Truncate long descriptions for UI display
        description: (item.description || '').slice(0, 200),
        score: Math.round(score * 100) / 100,
        source: 'india',
        publisher: item.publisher || '',
        url: item.link || '',
      });
    }
  }
  // Average scores per symbol; sort headlines by |score| descending
  // so the most impactful one shows first.
  const scoreMap = {};
  const headlinesMap = {};
  for (const [sym, scores] of Object.entries(perSymbolScores)) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    scoreMap[sym] = Math.max(-1, Math.min(1, avg));
    headlinesMap[sym] = (perSymbolHeadlines[sym] || [])
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, 5); // keep top 5 most impactful per symbol
  }
  return { scoreMap, headlinesMap };
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
 *   headlinesMap: Record<string, Array<{title, description, score, source}>>,
 *   vix: number|null,
 *   fii: number|null,
 *   dii: number|null,
 *   newsCount: number,
 *   fetchedAt: string,
 * }>}
 */
export async function fetchLiveMarketContext(symbolUniverse) {
  const [vixRes, flowRes, newsRes] = await Promise.all([
    fetchLiveVix(),
    fetchLiveFiiDii(),
    fetchLiveNews(symbolUniverse || new Set()),
  ]);

  return {
    vixRegime: vixRes.regime,
    flow: flowRes.flow,
    newsMap: newsRes.scoreMap || {},
    headlinesMap: newsRes.headlinesMap || {},
    vix: vixRes.vix,
    fii: flowRes.fii,
    dii: flowRes.dii,
    newsCount: Object.keys(newsRes.scoreMap || {}).length,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Clear all per-layer caches so the next call refetches from the Worker.
 * Exposed for tests and for the rare case where a caller needs to force
 * a fresh pull within the 10-min TTL window (e.g. after a manual refresh
 * action). Under normal operation the TTL handles staleness on its own.
 */
export function clearMarketContextCache() {
  vixCache.vix = null;
  vixCache.regime = null;
  vixCache.fetchedAt = 0;
  vixInflight = null;
  flowCache.fii = null;
  flowCache.dii = null;
  flowCache.flow = null;
  flowCache.fetchedAt = 0;
  flowInflight = null;
  newsItemsCache.items = null;
  newsItemsCache.fetchedAt = 0;
  newsItemsInflight = null;
}

/**
 * Per-symbol news lookup for the single-stock scanner detail view.
 * Hits the same broad-feed map (`/news/india`) the batch scan uses but
 * scopes the universe to the one symbol — which means the headlines
 * returned are exactly those that mention this stock today.
 *
 * Cheap because the underlying broad-feed is cached at the worker
 * (10min market hours / 60min off-hours) and re-used across calls in
 * this module's 10-min in-flight cache. No per-symbol Worker fetch.
 *
 * Returns the same shape as the old Google-backed lookup so call sites
 * (useStockScan.js) don't need to change.
 *
 * @param {string} symbol  e.g. "RELIANCE"
 * @returns {Promise<{
 *   score: number|null,
 *   headlines: Array<{title, description, score, source, publisher}>
 * }>}
 */
export async function fetchLiveBroadFeedForSymbol(symbol) {
  if (!symbol) return { score: null, headlines: [] };
  const clean = String(symbol).toUpperCase().replace(/\.NS$/, '');
  try {
    const { scoreMap, headlinesMap } = await fetchLiveNews(new Set([clean]));
    return {
      score: scoreMap[clean] ?? null,
      headlines: headlinesMap[clean] || [],
    };
  } catch {
    return { score: null, headlines: [] };
  }
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
