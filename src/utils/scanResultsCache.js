/**
 * scanResultsCache — persist the most recent batch scan to localStorage so a
 * page reload, accidental nav, or backgrounded tab kill doesn't force the
 * user to rerun a 30-300 stock scan.
 *
 * Keyed by the tuple (engine, index, timeframe, dataSource) so switching any
 * scan dimension shows fresh state instead of stale cross-engine results.
 *
 * Stored payload is intentionally trimmed:
 *   - Result rows keep symbol/action/conf/entry/sl/target/pattern/news basics
 *     — enough to render the full ResultCard.
 *   - Telemetry summary kept verbatim (it's already small).
 *   - Heavy fields (raw OHLCV, full headline arrays > 5) are dropped to keep
 *     under ~300KB which fits comfortably in localStorage's ~5MB quota.
 *
 * TTL: 4 hours. Anything older is treated as expired and dropped on read,
 * because intraday signals lose meaning as the day progresses.
 */

const KEY_PREFIX = 'cs.scanCache.v1.';
const MAX_AGE_MS = 4 * 60 * 60 * 1000;
// Cap headlines per row — full lists are sometimes 20+ items but the UI only
// renders 3, and persisting all of them risks blowing past quota.
const HEADLINES_PER_ROW = 5;

function buildKey({ engine, index, timeframe, dataSource }) {
  const parts = [
    engine || 'na',
    index || 'na',
    timeframe || 'na',
    dataSource || 'na',
  ].map((s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_'));
  return KEY_PREFIX + parts.join('.');
}

function trimResult(r) {
  if (!r || typeof r !== 'object') return null;
  const trimmed = {
    symbol: r.symbol,
    companyName: r.companyName,
    action: r.action,
    confidence: r.confidence,
    direction: r.direction,
    entry: r.entry,
    sl: r.sl,
    target: r.target,
    rr: r.rr,
    topPattern: r.topPattern,
    signalBarTs: r.signalBarTs,
    validTillTs: r.validTillTs,
    sector: r.sector,
    vixRegime: r.vixRegime,
    newsSentiment: r.newsSentiment,
    newsScore: r.newsScore,
  };
  if (Array.isArray(r.newsHeadlines) && r.newsHeadlines.length > 0) {
    trimmed.newsHeadlines = r.newsHeadlines
      .slice(0, HEADLINES_PER_ROW)
      .map((h) => ({
        title: h.title,
        score: h.score,
        url: h.url,
        publisher: h.publisher,
      }));
  }
  if (r.proximityInfo) {
    trimmed.proximityInfo = {
      direction: r.proximityInfo.direction,
      hint: r.proximityInfo.hint,
    };
  }
  return trimmed;
}

/**
 * Persist a scan to localStorage. Silent on quota / serialization errors —
 * cache is a best-effort UX improvement, never load-bearing.
 */
export function saveScanResults({
  engine, index, timeframe, dataSource,
  results, telemetry, savedAt,
}) {
  if (!Array.isArray(results) || results.length === 0) return false;
  try {
    const payload = {
      engine: engine || null,
      index: index || null,
      timeframe: timeframe || null,
      dataSource: dataSource || null,
      savedAt: savedAt || Date.now(),
      results: results.map(trimResult).filter(Boolean),
      telemetry: telemetry || null,
    };
    const key = buildKey({ engine, index, timeframe, dataSource });
    localStorage.setItem(key, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/**
 * Load a previously persisted scan. Returns null if missing, malformed, or
 * older than MAX_AGE_MS. Stale entries are eagerly removed so the user never
 * sees outdated suggestions on the next mount.
 */
export function loadScanResults({ engine, index, timeframe, dataSource, now = Date.now() }) {
  const key = buildKey({ engine, index, timeframe, dataSource });
  let raw;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.results)) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    return null;
  }
  const age = now - (parsed.savedAt || 0);
  if (age > MAX_AGE_MS) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    return null;
  }
  return parsed;
}

/**
 * Drop a single cached entry. Called when the user explicitly clears or
 * after a fresh scan completes (we replace rather than accumulate).
 */
export function clearScanResults({ engine, index, timeframe, dataSource }) {
  try {
    localStorage.removeItem(buildKey({ engine, index, timeframe, dataSource }));
  } catch { /* ignore */ }
}

export const __test = { buildKey, trimResult, KEY_PREFIX, MAX_AGE_MS };
