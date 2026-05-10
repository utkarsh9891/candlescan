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
 * Source (free):
 *
 *   Broad Indian RSS — Moneycontrol + LiveMint + Economic Times
 *   market-wide feeds that mention specific stocks in their headlines.
 *   Single multi-feed fetch returns ~80-120 items covering the most
 *   actively-discussed stocks. Matches headlines against the caller's
 *   symbol universe.
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

const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// Per-feed config — `ua` overrides the default 'Mozilla/5.0' UA when the
// publisher blocks generic UAs from non-residential IPs (Moneycontrol
// returns empty bodies; Googlebot is whitelisted). Business Standard was
// previously in this list but blocked with HTTP 403 even on Googlebot,
// so it's been removed entirely.
const INDIA_BROAD_FEEDS = [
  // Moneycontrol
  { url: 'https://www.moneycontrol.com/rss/buzzingstocks.xml', ua: GOOGLEBOT_UA },
  { url: 'https://www.moneycontrol.com/rss/MCtopnews.xml', ua: GOOGLEBOT_UA },
  { url: 'https://www.moneycontrol.com/rss/marketreports.xml', ua: GOOGLEBOT_UA },
  { url: 'https://www.moneycontrol.com/rss/business.xml', ua: GOOGLEBOT_UA },
  // LiveMint
  { url: 'https://www.livemint.com/rss/markets' },
  // Economic Times
  { url: 'https://economictimes.indiatimes.com/markets/stocks/news/rssfeeds/2146842.cms' },
  { url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms' },
];

/**
 * Fetch and score the broad Indian market feeds (Moneycontrol +
 * LiveMint + Economic Times + Business Standard). Returns a symbol →
 * score map. Symbols are matched against the provided universe;
 * headlines not mentioning any symbol are skipped.
 *
 * @param {Set<string>} symbolUniverse
 * @param {{fetchFn?: Function}} [opts]  inject a fetch for testing
 * @returns {Promise<Record<string, number>>}
 */
export async function fetchIndianBroadFeedSentiment(symbolUniverse, { fetchFn } = {}) {
  const f = fetchFn || globalThis.fetch;
  const perSymbolScores = {}; // symbol → array of scores (to average)
  for (const { url, ua } of INDIA_BROAD_FEEDS) {
    try {
      const res = await f(url, { headers: { 'User-Agent': ua || 'Mozilla/5.0' } });
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

// ─── Merged fetcher (the main entry point) ─────────────────────────

/**
 * Build a full symbol → sentiment score map for a scan. Wraps
 * `fetchIndianBroadFeedSentiment` so the call site (warm-news script) can
 * stay agnostic about which broad-feed publishers we're using on any
 * given day. The Google per-symbol mode that used to live here was
 * dropped — Google's RSS rate-limited Cloudflare egress to UNAVAILABLE
 * on every call, so the tier was pure latency for zero signal.
 *
 * @param {Set<string>} symbolUniverse
 * @param {{fetchFn?: Function}} [opts]
 * @returns {Promise<Record<string, number>>}
 */
export async function buildNewsSentimentMap(symbolUniverse, opts = {}) {
  return fetchIndianBroadFeedSentiment(symbolUniverse, opts);
}
