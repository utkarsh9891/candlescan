/**
 * nseIndexCache — long-lived browser localStorage cache for NSE index
 * constituents, so repeated scans don't re-hit NSE's flaky rate-limited
 * equity-stockIndices endpoint.
 *
 * Policy:
 *   - TTL 7 days. NSE index membership is stable day-to-day; new listings
 *     join a major index <1/week on average.
 *   - Fresh entries are returned as-is.
 *   - Expired entries are NOT silently returned by `getCachedIndexSymbols` —
 *     callers that want graceful-degradation on a failing network must call
 *     `getStaleIndexSymbols` explicitly.
 *   - Never throws. Quota / parse errors produce a `console.warn` and a
 *     silent fall-through (`null` from reads, no-op on writes).
 *
 * Key shape: `candlescan_nse_index:<indexName>` e.g.
 *   `candlescan_nse_index:NIFTY SMALLCAP 100`
 * Value shape: JSON `{ symbols: string[], fetchedAt: number, expiresAt: number }`.
 */

export const NSE_INDEX_CACHE_PREFIX = 'candlescan_nse_index:';
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Hint threshold for the caller: entries older than this are stale-ish
 *  and the hook kicks off a background refresh while still using them. */
export const BACKGROUND_REFRESH_AGE_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

function storage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function keyFor(indexName) {
  return NSE_INDEX_CACHE_PREFIX + indexName;
}

function readEntry(indexName) {
  const ls = storage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(keyFor(indexName));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.symbols)) return null;
    if (typeof parsed.fetchedAt !== 'number' || typeof parsed.expiresAt !== 'number') return null;
    return parsed;
  } catch {
    // Corrupt entry — nuke it so the next write starts clean
    try { ls.removeItem(keyFor(indexName)); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Return cached symbols for an index if the entry is still fresh (not past
 * its expiry). Returns `null` on miss, expired, or parse error.
 * @param {string} indexName exactly as used in NSE API (e.g. "NIFTY 200").
 * @returns {{ symbols: string[], fetchedAt: number, expiresAt: number } | null}
 */
export function getCachedIndexSymbols(indexName) {
  const entry = readEntry(indexName);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) return null;
  return entry;
}

/**
 * Persist symbols for an index, stamped with expiry metadata.
 * Silent no-op if localStorage is unavailable or the quota is hit.
 * @param {string} indexName
 * @param {string[]} symbols
 * @param {{ ttlMs?: number }} [opts]
 */
export function setCachedIndexSymbols(indexName, symbols, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const ls = storage();
  if (!ls) return;
  if (!Array.isArray(symbols) || symbols.length === 0) return;
  const now = Date.now();
  const payload = {
    symbols,
    fetchedAt: now,
    expiresAt: now + Math.max(0, ttlMs),
  };
  try {
    ls.setItem(keyFor(indexName), JSON.stringify(payload));
  } catch (err) {
    // Most commonly: QuotaExceededError. Cache is advisory — don't crash.
    // eslint-disable-next-line no-console
    console.warn('[nseIndexCache] set failed:', err?.message || err);
  }
}

/**
 * Retrieve the cache entry regardless of expiry — used as the last-resort
 * fallback when a fresh fetch fails and *any* stored symbol list is better
 * than an empty view.
 * @param {string} indexName
 * @returns {{ symbols: string[], fetchedAt: number, expiresAt: number } | null}
 */
export function getStaleIndexSymbols(indexName) {
  return readEntry(indexName);
}

/**
 * Remove the cache entry for a specific index.
 * @param {string} indexName
 */
export function clearIndexCache(indexName) {
  const ls = storage();
  if (!ls) return;
  try { ls.removeItem(keyFor(indexName)); } catch { /* ignore */ }
}

/**
 * Remove every `candlescan_nse_index:*` entry in localStorage.
 * Used by the "Clear NSE cache" button in Settings and by dev tooling.
 */
export function clearAllIndexCaches() {
  const ls = storage();
  if (!ls) return;
  try {
    const victims = [];
    for (let i = 0; i < ls.length; i += 1) {
      const k = ls.key(i);
      if (k && k.startsWith(NSE_INDEX_CACHE_PREFIX)) victims.push(k);
    }
    for (const k of victims) {
      try { ls.removeItem(k); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/**
 * Inspect the cache for diagnostic/UI purposes.
 * Returns `{ count, oldestAgeMs }` where `oldestAgeMs` is the age of the
 * oldest stored entry (0 if no entries). Never throws.
 * @returns {{ count: number, oldestAgeMs: number }}
 */
export function summarizeIndexCache() {
  const ls = storage();
  if (!ls) return { count: 0, oldestAgeMs: 0 };
  const now = Date.now();
  let count = 0;
  let oldestFetchedAt = now;
  try {
    for (let i = 0; i < ls.length; i += 1) {
      const k = ls.key(i);
      if (!k || !k.startsWith(NSE_INDEX_CACHE_PREFIX)) continue;
      try {
        const parsed = JSON.parse(ls.getItem(k) || '');
        if (parsed && Array.isArray(parsed.symbols) && typeof parsed.fetchedAt === 'number') {
          count += 1;
          if (parsed.fetchedAt < oldestFetchedAt) oldestFetchedAt = parsed.fetchedAt;
        }
      } catch { /* skip corrupt */ }
    }
  } catch { /* ignore */ }
  return { count, oldestAgeMs: count === 0 ? 0 : Math.max(0, now - oldestFetchedAt) };
}
