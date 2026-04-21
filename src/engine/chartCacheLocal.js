/**
 * chartCacheLocal.js — localStorage wrapper for OHLCV chart data.
 *
 * Why: the CF Worker has a KV cache and the Vite dev server has a disk
 * cache (vite-plugin-chart-cache.mjs), but in production-browser mode
 * every scan historically re-fetched the same day's candles from Yahoo /
 * Dhan / Kite. A 24h localStorage cache cuts that by ~95% for the
 * "scan the same index multiple times" workflow and keeps us clear of
 * vendor rate limits even during burst usage.
 *
 * Key shape:
 *   candlescan_chart:{source}:{symbol}:{interval}:{date}
 *   candlescan_chart:{source}:{symbol}:{interval}:{date}:meta
 *
 *   source   = 'yahoo' | 'dhan' | 'kite'
 *   symbol   = uppercase NSE symbol (no .NS)
 *   interval = '1m' | '5m' | '15m' | '1h' | '1d' | ...
 *   date     = YYYY-MM-DD (IST trading day); use 'latest' for non-dated fetches
 *
 * TTL: 24h default. Historical intraday is immutable once the day closes,
 * so 24h is conservative; same-day fetches refresh on the next session
 * anyway.
 *
 * Every write also stores a `:meta` sibling with `{fetchedAt, expiresAt,
 * size}`. `size` is the byte length of the candle payload — used by the
 * opportunistic LRU eviction on the next write when total cache size is
 * above 4MB.
 *
 * Graceful degradation: every public call wraps localStorage access in a
 * try/catch. If storage is unavailable (SSR, disabled, quota full) we
 * silently return null on get and no-op on set — never throw.
 */

const PREFIX = 'candlescan_chart:';
const META_SUFFIX = ':meta';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_TOTAL_BYTES = 4 * 1024 * 1024; // 4MB opportunistic LRU trigger
const EVICT_FRACTION = 0.1; // evict 10% oldest on overflow

function hasStorage() {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

function buildKey(source, symbol, interval, date) {
  const sym = String(symbol || '').trim().toUpperCase().replace(/\.NS$/i, '');
  const src = String(source || '').trim().toLowerCase();
  const iv = String(interval || '').trim();
  const dt = String(date || 'latest').trim();
  return `${PREFIX}${src}:${sym}:${iv}:${dt}`;
}

/**
 * Read cached candles for (source, symbol, interval, date).
 * Returns { candles, fetchedAt } on hit, or null on miss / expired / error.
 */
export function getCachedChart(source, symbol, interval, date) {
  if (!hasStorage()) return null;
  const key = buildKey(source, symbol, interval, date);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.candles)) return null;
    const expiresAt = Number(parsed.expiresAt || 0);
    if (expiresAt && expiresAt < Date.now()) {
      // Expired — evict both the payload and its meta sidecar.
      try { localStorage.removeItem(key); } catch { /* noop */ }
      try { localStorage.removeItem(key + META_SUFFIX); } catch { /* noop */ }
      return null;
    }
    return { candles: parsed.candles, fetchedAt: parsed.fetchedAt || null };
  } catch {
    return null;
  }
}

/**
 * Cache candles for (source, symbol, interval, date).
 *
 * No-op on any storage error. Empty / non-array candles are not cached
 * (prevents poisoning the cache with failed fetches).
 */
export function setCachedChart(source, symbol, interval, date, candles, opts = {}) {
  if (!hasStorage()) return;
  if (!Array.isArray(candles) || candles.length === 0) return;

  const ttlMs = Math.max(1000, Number(opts.ttlMs ?? DEFAULT_TTL_MS));
  const now = Date.now();
  const expiresAt = now + ttlMs;
  const key = buildKey(source, symbol, interval, date);
  const metaKey = key + META_SUFFIX;
  const payload = { candles, fetchedAt: now, expiresAt };

  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return;
  }

  // Opportunistic LRU: if we'd push total chart-cache size above 4MB,
  // evict the oldest ~10% of entries before writing.
  try {
    maybeEvict(serialized.length);
  } catch { /* noop — eviction is best-effort */ }

  try {
    localStorage.setItem(key, serialized);
    localStorage.setItem(
      metaKey,
      JSON.stringify({ fetchedAt: now, expiresAt, size: serialized.length })
    );
  } catch {
    // Quota exceeded or disabled — last-ditch: try evicting half and retrying once.
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

/**
 * Iterate localStorage for every chart-cache entry. Returns entries with
 * their fetchedAt and size, sorted oldest-first. Internal helper.
 */
function listChartEntries() {
  const out = [];
  if (!hasStorage()) return out;
  let n = 0;
  try {
    n = localStorage.length;
  } catch {
    return out;
  }
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
  const entries = listChartEntries();
  let total = incomingBytes;
  for (const e of entries) total += e.size;
  if (total <= MAX_TOTAL_BYTES) return;
  evictOldest(EVICT_FRACTION, entries);
}

function evictOldest(fraction, entries) {
  const list = entries || listChartEntries();
  if (list.length === 0) return;
  const n = Math.max(1, Math.ceil(list.length * fraction));
  for (let i = 0; i < n; i++) {
    const e = list[i];
    try { localStorage.removeItem(e.key); } catch { /* noop */ }
    try { localStorage.removeItem(e.key + META_SUFFIX); } catch { /* noop */ }
  }
}

/**
 * Clear cache entries for a source. If symbol is given, clear just that
 * symbol's entries across intervals/dates. Used for debug / refresh.
 */
export function clearChartCache(source, symbol) {
  if (!hasStorage()) return;
  const src = source ? String(source).trim().toLowerCase() : null;
  const sym = symbol
    ? String(symbol).trim().toUpperCase().replace(/\.NS$/i, '')
    : null;
  const keys = [];
  let n = 0;
  try { n = localStorage.length; } catch { return; }
  for (let i = 0; i < n; i++) {
    let k;
    try { k = localStorage.key(i); } catch { continue; }
    if (!k || !k.startsWith(PREFIX)) continue;
    const rest = k.slice(PREFIX.length);
    const [kSrc, kSym] = rest.split(':');
    if (src && kSrc !== src) continue;
    if (sym && kSym !== sym) continue;
    keys.push(k);
  }
  for (const k of keys) {
    try { localStorage.removeItem(k); } catch { /* noop */ }
    try { localStorage.removeItem(k + META_SUFFIX); } catch { /* noop */ }
  }
}

/** Exported for tests. */
export const _internals = {
  PREFIX,
  META_SUFFIX,
  DEFAULT_TTL_MS,
  MAX_TOTAL_BYTES,
  EVICT_FRACTION,
  buildKey,
  listChartEntries,
};
