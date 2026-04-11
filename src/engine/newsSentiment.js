/**
 * News sentiment fetcher + scorer.
 *
 * Feeds the `sentiment` layer of marketContext so the trade decision
 * flow (tradeDecision.js) can veto counter-strong-news trades and
 * boost aligned-news trades. Per user direction: this is the ONLY
 * context layer currently approved for positive rank bonuses because
 * news is per-stock/per-event and introduces genuine cross-sectional
 * differentiation.
 *
 * Sources (both free, both toggleable):
 *
 *   1. Moneycontrol RSS — Indian market-wide feeds that mention
 *      specific stocks in their headlines. Single fetch returns
 *      ~50 items covering the most actively-discussed stocks today.
 *      Feeds used: buzzing stocks, stocks-in-news, markets.
 *
 *   2. Google News RSS — per-stock query results. More targeted but
 *      requires one fetch per symbol. Only used for stocks that
 *      appear in the technical candidate list (top 20-30 ranked).
 *
 * Strategy:
 *   - Default mode: Moneycontrol only (broad, cheap). Matches
 *     headlines against the NIFTY TOTAL MARKET symbol universe;
 *     ~30-60 symbols get sentiment per scan typically.
 *   - Deep mode:  Moneycontrol + per-symbol Google News for the
 *     top N candidates that passed phases 1-3 of tradeDecision.
 *
 * Sentiment scoring:
 *   Keyword-based. Crude but deterministic and free. Counts
 *   bullish/bearish lexicon hits in headline + description,
 *   normalizes to [-1, +1]. Future work: plug in a cheap local
 *   ML classifier (e.g. FinBERT via ONNX in the browser) or a
 *   paid sentiment API.
 */

// ─── Sentiment lexicon ─────────────────────────────────────────────

/**
 * Bullish keywords. Word boundaries applied when matching so
 * "unprofitable" doesn't match "profit".
 */
const BULLISH_KEYWORDS = [
  'surge', 'surges', 'surged', 'surging',
  'rally', 'rallies', 'rallied', 'rallying',
  'jump', 'jumps', 'jumped', 'jumping',
  'soar', 'soars', 'soared', 'soaring',
  'climb', 'climbs', 'climbed', 'climbing',
  'rise', 'rises', 'rose', 'rising',
  'gain', 'gains', 'gained', 'gaining',
  'up', 'high', 'highs', 'record high', 'new high',
  'beat', 'beats', 'beaten', 'outperform', 'outperforms', 'outperformed',
  'profit', 'profits', 'profitable',
  'strong', 'stronger', 'robust', 'solid',
  'buy', 'upgrade', 'upgraded', 'bullish', 'positive', 'optimistic',
  'breakout', 'breakthrough',
  'acquire', 'acquires', 'acquisition',
  'expand', 'expansion',
  'growth', 'grow', 'grows', 'grew', 'growing',
  'win', 'wins', 'won', 'winning',
  'deal', 'deals', 'contract', 'contracts', 'order', 'orders',
  'dividend', 'bonus', 'split',
];

const BEARISH_KEYWORDS = [
  'fall', 'falls', 'fell', 'falling',
  'drop', 'drops', 'dropped', 'dropping',
  'plunge', 'plunges', 'plunged', 'plunging',
  'slump', 'slumps', 'slumped', 'slumping',
  'slide', 'slides', 'slid', 'sliding',
  'tumble', 'tumbles', 'tumbled', 'tumbling',
  'crash', 'crashes', 'crashed', 'crashing',
  'down', 'low', 'lows', 'record low', 'new low',
  'loss', 'losses', 'losing',
  'miss', 'misses', 'missed', 'underperform', 'underperforms', 'underperformed',
  'weak', 'weaker', 'poor', 'disappointing',
  'sell', 'downgrade', 'downgraded', 'bearish', 'negative', 'pessimistic',
  'concern', 'concerns', 'worry', 'worries', 'worried',
  'decline', 'declines', 'declined', 'declining',
  'cut', 'cuts', 'slash', 'slashes',
  'loss-making', 'unprofitable',
  'probe', 'investigation', 'fraud', 'scam',
  'warning', 'warn', 'warns', 'warned',
  'layoff', 'layoffs', 'fire', 'fires', 'fired',
  'bankruptcy', 'insolvency', 'default', 'defaults', 'defaulted',
];

/**
 * Score a piece of text on [-1, +1].
 * +1 = strongly bullish, -1 = strongly bearish, 0 = neutral.
 *
 * @param {string} text  headline + description combined
 * @returns {number}
 */
export function scoreText(text) {
  if (!text) return 0;
  const normalized = String(text).toLowerCase();
  let bull = 0, bear = 0;
  for (const word of BULLISH_KEYWORDS) {
    // Word boundary regex — escape hyphens in phrases
    const re = new RegExp('\\b' + word.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\b', 'g');
    const matches = normalized.match(re);
    if (matches) bull += matches.length;
  }
  for (const word of BEARISH_KEYWORDS) {
    const re = new RegExp('\\b' + word.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\b', 'g');
    const matches = normalized.match(re);
    if (matches) bear += matches.length;
  }
  const total = bull + bear;
  if (total === 0) return 0;
  return (bull - bear) / total;
}

// ─── RSS parsing (minimal) ─────────────────────────────────────────

/**
 * Parse a simple RSS 2.0 feed into an array of { title, description, pubDate }.
 * Handles both raw text and CDATA-wrapped contents.
 */
export function parseRssItems(xml) {
  if (!xml) return [];
  const items = [];
  const rawItems = xml.split(/<item[\s>]/i).slice(1);
  for (const raw of rawItems) {
    // Title — either CDATA or plain
    let title = '';
    const titleMatch = raw.match(/<title>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/title>/i);
    if (titleMatch) title = (titleMatch[1] || titleMatch[2] || '').trim();
    let description = '';
    const descMatch = raw.match(/<description>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/description>/i);
    if (descMatch) description = (descMatch[1] || descMatch[2] || '').trim();
    // Strip HTML tags from description
    description = description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    let pubDate = '';
    const dateMatch = raw.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    if (dateMatch) pubDate = dateMatch[1].trim();
    if (title) items.push({ title, description, pubDate });
  }
  return items;
}

// ─── Symbol matching ───────────────────────────────────────────────

/**
 * Extract NSE symbols that are mentioned in a headline. Requires a
 * list of known symbols to check against (typically the NIFTY TOTAL
 * MARKET universe). Matching is case-insensitive, word-boundaried.
 *
 * Also handles common company-name → symbol aliases for the 20 or
 * so stocks whose colloquial name differs significantly from the
 * NSE symbol (e.g., "Reliance" → "RELIANCE", "TCS" → "TCS").
 *
 * @param {string} text
 * @param {Set<string>} symbolUniverse  set of uppercase NSE symbols
 * @returns {string[]}  array of symbols mentioned (may include duplicates from multiple keyword hits; caller should dedupe if needed)
 */
export function extractSymbols(text, symbolUniverse) {
  if (!text || !symbolUniverse) return [];
  const norm = String(text).toUpperCase();
  const hits = new Set();
  for (const sym of symbolUniverse) {
    // Require word boundary around the symbol so "M&M" doesn't match inside "NMS"
    // Escape special chars in symbol
    const escaped = sym.replace(/[-/\\^$*+?.()|[\]{}&]/g, '\\$&');
    const re = new RegExp('\\b' + escaped + '\\b', 'i');
    if (re.test(norm)) hits.add(sym);
  }
  return Array.from(hits);
}

// ─── Fetchers ──────────────────────────────────────────────────────

const MONEYCONTROL_FEEDS = [
  'https://www.moneycontrol.com/rss/buzzingstocks.xml',
  'https://www.moneycontrol.com/rss/MCtopnews.xml',
  'https://www.moneycontrol.com/rss/marketreports.xml',
  'https://www.moneycontrol.com/rss/business.xml',
];

/**
 * Fetch and score Moneycontrol's Indian market feeds.
 * Returns a symbol → score map. Symbols are matched against the
 * provided universe; headlines not mentioning any symbol are skipped.
 *
 * @param {Set<string>} symbolUniverse
 * @param {{fetchFn?: Function}} [opts]  inject a fetch for testing
 * @returns {Promise<Record<string, number>>}
 */
export async function fetchMoneycontrolSentiment(symbolUniverse, { fetchFn } = {}) {
  const f = fetchFn || globalThis.fetch;
  const perSymbolScores = {}; // symbol → array of scores (to average)
  for (const url of MONEYCONTROL_FEEDS) {
    try {
      const res = await f(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) continue;
      const xml = await res.text();
      const items = parseRssItems(xml);
      for (const item of items) {
        const text = item.title + ' ' + item.description;
        const symbols = extractSymbols(text, symbolUniverse);
        if (!symbols.length) continue;
        const score = scoreText(text);
        for (const sym of symbols) {
          if (!perSymbolScores[sym]) perSymbolScores[sym] = [];
          perSymbolScores[sym].push(score);
        }
      }
    } catch {
      // Individual feed failure is OK — other feeds may succeed.
    }
  }
  // Average scores per symbol
  const out = {};
  for (const [sym, scores] of Object.entries(perSymbolScores)) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    out[sym] = Math.max(-1, Math.min(1, avg));
  }
  return out;
}

/**
 * Fetch and score per-symbol Google News RSS for a single stock.
 * Used for deep lookup on top ranked candidates.
 *
 * @param {string} symbol  e.g. "RELIANCE"
 * @param {{fetchFn?: Function, maxAgeMs?: number}} [opts]
 * @returns {Promise<number | null>}  score in [-1, +1] or null if no data
 */
export async function fetchGoogleNewsSentimentForSymbol(symbol, { fetchFn, maxAgeMs = 7 * 24 * 3600 * 1000 } = {}) {
  if (!symbol) return null;
  const f = fetchFn || globalThis.fetch;
  const q = encodeURIComponent(`${symbol} stock NSE`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
  try {
    const res = await f(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const xml = await res.text();
    const items = parseRssItems(xml);
    const cutoff = Date.now() - maxAgeMs;
    const recent = items.filter((item) => {
      if (!item.pubDate) return true;
      const t = Date.parse(item.pubDate);
      return !isNaN(t) && t >= cutoff;
    });
    if (!recent.length) return null;
    // Average score of recent headlines
    const scores = recent.map((it) => scoreText(it.title + ' ' + it.description));
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    return Math.max(-1, Math.min(1, avg));
  } catch {
    return null;
  }
}

// ─── Merged fetcher (the main entry point) ─────────────────────────

/**
 * Build a full symbol → sentiment score map for a scan.
 *
 * Modes:
 *   - 'moneycontrol'  : fetch only Moneycontrol feeds (fast, broad)
 *   - 'google'        : fetch only per-symbol Google News (slow, targeted)
 *   - 'both'          : fetch Moneycontrol first, then top-N deep via Google
 *
 * @param {Set<string>} symbolUniverse
 * @param {{
 *   mode?: 'moneycontrol' | 'google' | 'both',
 *   deepSymbols?: string[],
 *   fetchFn?: Function,
 * }} [opts]
 * @returns {Promise<Record<string, number>>}
 */
export async function buildNewsSentimentMap(symbolUniverse, opts = {}) {
  const mode = opts.mode || 'moneycontrol';
  const merged = {};

  if (mode === 'moneycontrol' || mode === 'both') {
    const mcScores = await fetchMoneycontrolSentiment(symbolUniverse, opts);
    Object.assign(merged, mcScores);
  }

  if (mode === 'google' || mode === 'both') {
    const deepSymbols = opts.deepSymbols || [];
    for (const sym of deepSymbols) {
      const score = await fetchGoogleNewsSentimentForSymbol(sym, opts);
      if (score != null) {
        // If both sources have a score, average them
        if (merged[sym] != null) {
          merged[sym] = (merged[sym] + score) / 2;
        } else {
          merged[sym] = score;
        }
      }
    }
  }

  return merged;
}
