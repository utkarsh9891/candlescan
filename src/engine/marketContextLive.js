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
 * Caching strategy — per layer, 10-minute TTL:
 *   - Previously a single day-keyed cache wrapped all three layers,
 *     which silently pinned VIX and news for the whole trading session.
 *     That defeated the Worker KV's own 1h/10-60m refresh cadence, so
 *     the HIGH-VIX regime veto missed intraday regime changes and
 *     breaking news was invisible until the next UTC midnight.
 *   - Now each layer has its own 10-min TTL matching the Worker's
 *     Moneycontrol market-hours cadence, with per-layer in-flight
 *     de-duplication so concurrent scans issue exactly one CF call.
 *   - News items are cached as raw items; the per-universe scoreMap
 *     and headlinesMap are recomputed on every call because scoring
 *     depends on which symbols are in the caller's universe — without
 *     this, switching indices mid-session would serve the first scan's
 *     score map to the second.
 */

import { vixRegime, classifyInstitutionalFlow, classifyNewsSentiment } from './marketContext.js';
import { scoreText, extractSymbols } from './newsSentiment.js';

const CF_WORKER_URL = 'https://candlescan-proxy.utkarsh-dev.workers.dev';

/**
 * 10 minutes — matches the Worker's Moneycontrol KV TTL during market
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
 * Fetch raw Moneycontrol news items from the Worker. Cached with a
 * 10-min TTL. Kept separate from scoring because scoring depends on
 * the caller's symbol universe and must be recomputed each call.
 * @returns {Promise<Array<{title?: string, description?: string}>>}
 */
async function fetchRawMoneycontrolItems() {
  if (isFresh(newsItemsCache)) return newsItemsCache.items || [];
  if (newsItemsInflight) return newsItemsInflight;
  newsItemsInflight = (async () => {
    try {
      const res = await fetch(`${CF_WORKER_URL}/news/moneycontrol`, {
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
 * Fetch Moneycontrol news items and score them against a symbol universe.
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
 *   headlinesMap: Record<string, Array<{title, description, score}>>,
 * }>}
 */
export async function fetchLiveNews(symbolUniverse) {
  const items = await fetchRawMoneycontrolItems();
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
        source: 'moneycontrol',
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
 * Deep news lookup (headlines + score) for a single symbol via
 * Google News RSS. Used by the single-stock scanner screen so the
 * stock detail view can show the same news card that the batch
 * scanner shows on its result cards.
 *
 * Returns a shape identical to the batch path — caller can drop
 * `headlines` straight into the existing "RECENT NEWS" UI block.
 *
 * @param {string} symbol  e.g. "RELIANCE"
 * @returns {Promise<{
 *   score: number|null,
 *   headlines: Array<{title, description, score, source}>
 * }>}
 */
export async function fetchLiveGoogleNewsDetailForSymbol(symbol) {
  if (!symbol) return { score: null, headlines: [], cacheStatus: null };
  const clean = String(symbol).toUpperCase().replace(/\.NS$/, '');
  try {
    const res = await fetch(`${CF_WORKER_URL}/news/google?symbol=${encodeURIComponent(clean)}`, {
      headers: { Accept: 'application/json' },
    });
    // Worker now sets `X-Cache: HIT|STALE|MISS|UNAVAILABLE` (PR #198).
    // Surface it so the batchScan fallback chain can branch on stale /
    // unavailable upstream without a second network round trip.
    const cacheStatus = typeof res?.headers?.get === 'function'
      ? (res.headers.get('X-Cache') || null)
      : null;
    const cacheSource = typeof res?.headers?.get === 'function'
      ? (res.headers.get('X-Cache-Source') || null)
      : null;
    if (!res.ok) {
      return { score: null, headlines: [], cacheStatus, cacheSource };
    }
    const data = await res.json();
    const items = data.items || [];
    if (!items.length) return { score: null, headlines: [], cacheStatus, cacheSource };
    // Cutoff recent items only (5 days) — identical to the score-only path
    const cutoff = Date.now() - 5 * 24 * 3600 * 1000;
    const scored = [];
    for (const item of items) {
      if (item.pubDate) {
        const t = Date.parse(item.pubDate);
        if (!isNaN(t) && t < cutoff) continue;
      }
      const text = `${item.title || ''} ${item.description || ''}`;
      const s = scoreText(text);
      scored.push({
        title: item.title || '',
        description: (item.description || '').slice(0, 200),
        score: Math.round(s * 100) / 100,
        source: 'google',
      });
    }
    if (!scored.length) return { score: null, headlines: [], cacheStatus, cacheSource };
    const avg = scored.reduce((a, b) => a + b.score, 0) / scored.length;
    // Sort by most impactful first, cap to top 5 (matches batch UI behaviour)
    const headlines = scored
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, 5);
    return {
      score: Math.max(-1, Math.min(1, avg)),
      headlines,
      cacheStatus,
      cacheSource,
    };
  } catch {
    return { score: null, headlines: [], cacheStatus: null };
  }
}

/**
 * Deep news lookup for a single symbol via Google News RSS.
 * Moneycontrol's feeds are broad — they mention roughly the top
 * 50 most-discussed stocks each day. For symbols that passed
 * technical filters but weren't in Moneycontrol's headlines, this
 * endpoint fetches per-symbol Google News and scores the results.
 *
 * @param {string} symbol  e.g. "RELIANCE"
 * @returns {Promise<number | null>}  sentiment in [-1, +1] or null
 */
export async function fetchLiveGoogleNewsForSymbol(symbol) {
  if (!symbol) return null;
  const clean = String(symbol).toUpperCase().replace(/\.NS$/, '');
  try {
    const res = await fetch(`${CF_WORKER_URL}/news/google?symbol=${encodeURIComponent(clean)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.items || [];
    if (!items.length) return null;
    // Average score across recent headlines (cutoff: 5 days)
    const cutoff = Date.now() - 5 * 24 * 3600 * 1000;
    const scores = [];
    for (const item of items) {
      if (item.pubDate) {
        const t = Date.parse(item.pubDate);
        if (!isNaN(t) && t < cutoff) continue;
      }
      const s = scoreText(`${item.title || ''} ${item.description || ''}`);
      scores.push(s);
    }
    if (!scores.length) return null;
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    return Math.max(-1, Math.min(1, avg));
  } catch {
    return null;
  }
}

/**
 * Enrich a news map with deep Google News lookups for a list of symbols.
 * Called after phase-3 ranking to give the top-N candidates per-stock
 * news depth. Fetches in parallel (Promise.all) — browser is responsible
 * for the concurrency limit by only passing the top-N.
 *
 * Merges with existing newsMap: if a symbol already has a Moneycontrol
 * score, the two are averaged. Otherwise the Google score becomes the
 * new entry.
 *
 * @param {Record<string, number>} existingMap  from fetchLiveNews
 * @param {string[]} symbolsToEnrich            typically top 10-20 ranked
 * @returns {Promise<Record<string, number>>}   merged map
 */
export async function enrichWithGoogleNews(existingMap, symbolsToEnrich) {
  if (!symbolsToEnrich?.length) return existingMap || {};
  const merged = { ...(existingMap || {}) };
  const results = await Promise.all(
    symbolsToEnrich.map(async (sym) => ({
      sym: String(sym).toUpperCase().replace(/\.NS$/, ''),
      score: await fetchLiveGoogleNewsForSymbol(sym),
    }))
  );
  for (const { sym, score } of results) {
    if (score == null) continue;
    if (merged[sym] != null) {
      // Average Moneycontrol + Google for a balanced signal
      merged[sym] = (merged[sym] + score) / 2;
    } else {
      merged[sym] = score;
    }
  }
  return merged;
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
