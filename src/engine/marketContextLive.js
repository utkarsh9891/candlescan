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
import { scoreText, extractSymbols } from './newsSentiment.js';

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
 * Returns BOTH the aggregated score map AND the individual headlines
 * per symbol so the UI can show WHY a stock has the sentiment it does.
 *
 * @param {Set<string>} symbolUniverse  uppercase NSE symbols to match
 * @returns {Promise<{
 *   scoreMap: Record<string, number>,
 *   headlinesMap: Record<string, Array<{title, description, score}>>,
 * }>}
 */
export async function fetchLiveNews(symbolUniverse) {
  try {
    const res = await fetch(`${CF_WORKER_URL}/news/moneycontrol`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { scoreMap: {}, headlinesMap: {} };
    const data = await res.json();
    const items = data.items || [];
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
  } catch {
    return { scoreMap: {}, headlinesMap: {} };
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
 *   headlinesMap: Record<string, Array<{title, description, score, source}>>,
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

  const [vixRes, flowRes, newsRes] = await Promise.all([
    fetchLiveVix(),
    fetchLiveFiiDii(),
    fetchLiveNews(symbolUniverse || new Set()),
  ]);

  const result = {
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
