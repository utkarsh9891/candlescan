/**
 * newsCacheLocal.js — localStorage wrapper for per-symbol news results.
 *
 * Wave 1.5d companion to the `batchScan.js` fallback chain. The CF Worker
 * now serves Google News through a KV stale-cache layer (PR #198), and
 * this browser-side cache sits in front of the Worker:
 *
 *   in-memory hour cache (batchScan)
 *      → localStorage (this module, survives page reload)
 *          → Worker (KV HIT | STALE | MISS | UNAVAILABLE)
 *              → Moneycontrol index map fallback
 *
 * Key shape:
 *   candlescan_news_v2:{SYMBOL}:{YYYY-MM-DD}
 *   candlescan_news_v2:{SYMBOL}:{YYYY-MM-DD}:meta
 *
 *   SYMBOL = uppercase NSE symbol (no .NS)
 *   date   = IST calendar day when the fetch was stored; news *does*
 *            change intraday, so the date key only namespaces entries —
 *            freshness is enforced by `expiresAt`, not by the key.
 *
 * The `_v2` prefix exists to invalidate every device's cache after the
 * Worker started filtering Yahoo's generic-feed garbage by relatedTickers.
 * Pre-v2 entries persisted Yahoo's irrelevant US headlines (Southern
 * Copper, Dutch Bros, etc.) under Indian-stock keys; bumping the prefix
 * is the cheapest way to force a clean refetch on every device. Old
 * `candlescan_news:` entries are swept on module load below.
 *
 * TTL: 4h during market hours, 12h off-hours. Rationale:
 *   - During market hours news sentiment can flip a position mid-session
 *     (downgrade, block deal, earnings guidance), so we re-fetch often.
 *   - Off-hours the feed is effectively static (weekend, overnight), so
 *     a longer TTL cuts Worker pressure without losing freshness.
 *
 * Unlike `chartCacheLocal`, there is **no `shouldCache` today-bypass**
 * guard here. The whole point of this cache is to dedupe per-symbol
 * news fetches within a TTL bucket on the *current* trading day —
 * that's where the Worker load comes from. The TTL itself is the
 * freshness guarantee.
 *
 * Graceful degradation: every public call wraps localStorage access in
 * a try/catch. Quota-exceeded / disabled / SSR → silent no-op (set) or
 * null (get); never throws.
 */

const PREFIX = 'candlescan_news_v2:';
const LEGACY_PREFIX = 'candlescan_news:'; // pre-v2 — swept on module load
const META_SUFFIX = ':meta';

/**
 * One-shot cleanup of legacy (pre-v2) cache entries. Runs at module
 * load time; cheap on devices that never had the legacy prefix because
 * the loop short-circuits when no key matches. v2 keys (which start
 * with `candlescan_news_v2:`) don't collide with the legacy prefix
 * (`candlescan_news:`) because position 15 differs ('_' vs ':'), so
 * the simple startsWith check is safe.
 */
function purgeLegacyEntries() {
  if (!hasStorage()) return;
  let n = 0;
  try { n = localStorage.length; } catch { return; }
  const stale = [];
  for (let i = 0; i < n; i++) {
    let k;
    try { k = localStorage.key(i); } catch { continue; }
    if (k && k.startsWith(LEGACY_PREFIX) && !k.startsWith(PREFIX)) {
      stale.push(k);
    }
  }
  for (const k of stale) {
    try { localStorage.removeItem(k); } catch { /* noop */ }
  }
}

// TTL split — market hours vs off-hours. Callers can still override via
// `opts.ttlMs` on setCachedNews for tests.
const TTL_MARKET_MS = 4 * 60 * 60 * 1000;    // 4 hours
const TTL_OFFHOURS_MS = 12 * 60 * 60 * 1000; // 12 hours

const MAX_TOTAL_BYTES = 1 * 1024 * 1024; // 1MB opportunistic LRU trigger
const EVICT_FRACTION = 0.2;              // evict 20% oldest on overflow

const IST_OFFSET_MIN = 330; // +5:30

/**
 * Current IST calendar date as YYYY-MM-DD. Used as the date segment of
 * the cache key. IST shifting handles the case where the browser clock
 * is set to UTC / a non-IST zone.
 */
function getTodayIST() {
  const shifted = new Date(Date.now() + IST_OFFSET_MIN * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Heuristic: are NSE cash markets open right now (IST)?
 * Mon-Fri, 09:15 - 15:30. We avoid importing `src/utils/marketHours.js`
 * so this module stays dependency-free (pure engine helper).
 */
function isMarketHoursIST() {
  const nowMs = Date.now() + IST_OFFSET_MIN * 60_000;
  const d = new Date(nowMs);
  // UTC getters because we already shifted the timestamp into IST.
  const day = d.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const minOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  return minOfDay >= 9 * 60 + 15 && minOfDay < 15 * 60 + 30;
}

/** Return the default TTL based on current IST market hours. */
function defaultTtlMs() {
  return isMarketHoursIST() ? TTL_MARKET_MS : TTL_OFFHOURS_MS;
}

function hasStorage() {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/\.NS$/i, '');
}

function buildKey(symbol, date) {
  const sym = normalizeSymbol(symbol);
  const dt = String(date || getTodayIST()).trim();
  return `${PREFIX}${sym}:${dt}`;
}

/**
 * Read cached news for a symbol. Date defaults to today's IST date.
 * Returns the stored `{score, headlines, source, fetchedAt, expiresAt}`
 * shape on hit, or `null` on miss / expired / corrupt / storage error.
 *
 * @param {string} symbol
 * @param {string} [date]  YYYY-MM-DD IST, defaults to today IST
 */
export function getCachedNews(symbol, date) {
  if (!hasStorage() || !symbol) return null;
  const key = buildKey(symbol, date);
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
    // Corrupt entry — evict both sides so we don't keep tripping on it.
    try { localStorage.removeItem(key); } catch { /* noop */ }
    try { localStorage.removeItem(key + META_SUFFIX); } catch { /* noop */ }
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const expiresAt = Number(parsed.expiresAt || 0);
  if (expiresAt && expiresAt < Date.now()) {
    try { localStorage.removeItem(key); } catch { /* noop */ }
    try { localStorage.removeItem(key + META_SUFFIX); } catch { /* noop */ }
    return null;
  }
  return parsed;
}

/**
 * Cache a per-symbol news payload.
 *
 * @param {string} symbol
 * @param {Object} value
 * @param {number|null} value.score        sentiment in [-1, +1] or null
 * @param {Array}       [value.headlines]  list of headline objects
 * @param {string}      [value.source]     'google' | 'stale' | 'moneycontrol' | 'none'
 * @param {Object}      [opts]
 * @param {number}      [opts.ttlMs]       override TTL (tests)
 * @param {string}      [opts.date]        override date (tests)
 */
export function setCachedNews(symbol, value, opts = {}) {
  if (!hasStorage() || !symbol || !value) return;
  // Never cache a literal "no data" sentinel — it would suppress future
  // legitimate fetches within the TTL window. We only persist entries
  // that produced an actual score OR at least one headline.
  const hasScore = value.score != null;
  const hasHeadlines = Array.isArray(value.headlines) && value.headlines.length > 0;
  if (!hasScore && !hasHeadlines) return;

  const ttlMs = Math.max(1000, Number(opts.ttlMs ?? defaultTtlMs()));
  const now = Date.now();
  const expiresAt = now + ttlMs;
  const key = buildKey(symbol, opts.date);
  const metaKey = key + META_SUFFIX;
  const payload = {
    score: value.score ?? null,
    headlines: Array.isArray(value.headlines) ? value.headlines : [],
    source: value.source || 'google',
    fetchedAt: now,
    expiresAt,
  };

  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return;
  }

  try { maybeEvict(serialized.length); } catch { /* noop */ }

  try {
    localStorage.setItem(key, serialized);
    localStorage.setItem(
      metaKey,
      JSON.stringify({ fetchedAt: now, expiresAt, size: serialized.length })
    );
  } catch {
    // Quota exceeded — try aggressive eviction + single retry.
    try {
      evictOldest(0.5);
      localStorage.setItem(key, serialized);
      localStorage.setItem(
        metaKey,
        JSON.stringify({ fetchedAt: now, expiresAt, size: serialized.length })
      );
    } catch { /* give up silently */ }
  }
}

/** Internal: list all news-cache entries with meta, sorted oldest-first. */
function listNewsEntries() {
  const out = [];
  if (!hasStorage()) return out;
  let n = 0;
  try { n = localStorage.length; } catch { return out; }
  for (let i = 0; i < n; i++) {
    let k;
    try { k = localStorage.key(i); } catch { continue; }
    if (!k || !k.startsWith(PREFIX)) continue;
    if (k.endsWith(META_SUFFIX)) continue;
    let fetchedAt = 0;
    let size = 0;
    try {
      const metaRaw = localStorage.getItem(k + META_SUFFIX);
      if (metaRaw) {
        const meta = JSON.parse(metaRaw);
        fetchedAt = Number(meta?.fetchedAt || 0);
        size = Number(meta?.size || 0);
      }
    } catch { /* noop */ }
    if (!size) {
      try {
        const raw = localStorage.getItem(k);
        if (raw) size = raw.length;
      } catch { /* noop */ }
    }
    out.push({ key: k, fetchedAt, size });
  }
  out.sort((a, b) => a.fetchedAt - b.fetchedAt);
  return out;
}

function maybeEvict(incomingBytes) {
  const entries = listNewsEntries();
  let total = incomingBytes;
  for (const e of entries) total += e.size;
  if (total <= MAX_TOTAL_BYTES) return;
  evictOldest(EVICT_FRACTION, entries);
}

function evictOldest(fraction, entries) {
  const list = entries || listNewsEntries();
  if (list.length === 0) return;
  const n = Math.max(1, Math.ceil(list.length * fraction));
  for (let i = 0; i < n; i++) {
    const e = list[i];
    try { localStorage.removeItem(e.key); } catch { /* noop */ }
    try { localStorage.removeItem(e.key + META_SUFFIX); } catch { /* noop */ }
  }
}

/**
 * Clear every news-cache entry. If `symbol` is given, only that symbol's
 * entries are cleared (across dates). Used by tests and the
 * manual-refresh code path.
 */
export function clearNewsCache(symbol) {
  if (!hasStorage()) return;
  const sym = symbol ? normalizeSymbol(symbol) : null;
  const keys = [];
  let n = 0;
  try { n = localStorage.length; } catch { return; }
  for (let i = 0; i < n; i++) {
    let k;
    try { k = localStorage.key(i); } catch { continue; }
    if (!k || !k.startsWith(PREFIX)) continue;
    const rest = k.slice(PREFIX.length).replace(META_SUFFIX, '');
    const kSym = rest.split(':')[0];
    if (sym && kSym !== sym) continue;
    keys.push(k);
  }
  for (const k of keys) {
    try { localStorage.removeItem(k); } catch { /* noop */ }
    if (!k.endsWith(META_SUFFIX)) {
      try { localStorage.removeItem(k + META_SUFFIX); } catch { /* noop */ }
    }
  }
}

/** Exported for tests. */
export const _internals = {
  PREFIX,
  LEGACY_PREFIX,
  META_SUFFIX,
  TTL_MARKET_MS,
  TTL_OFFHOURS_MS,
  MAX_TOTAL_BYTES,
  EVICT_FRACTION,
  buildKey,
  defaultTtlMs,
  isMarketHoursIST,
  listNewsEntries,
  purgeLegacyEntries,
};

// One-shot at module load — wipe pre-v2 entries left over from before
// the Worker-side relatedTickers filter shipped.
purgeLegacyEntries();
