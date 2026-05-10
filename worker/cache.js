/**
 * KV-backed cache helpers for the Cloudflare Worker.
 *
 * Wraps `env.CANDLESCAN_KV` with a stale-on-upstream-fail pattern,
 * a 30s in-memory write-dedupe micro-cache (to keep bursty scans
 * from burning through the free-plan 1000 writes/day budget), and
 * a uniform `X-Cache*` header surface so the browser / telemetry
 * can see cache behaviour without guessing from latency.
 *
 * All helpers are pure / side-effect-free at module load so they
 * can be unit-tested under Vitest with a small in-memory KV stub.
 *
 * Used by `/market/vix`, `/market/fiidii`, `/news/india`,
 * `/news/google` in `worker/index.js`.
 */

// ───────────────────────────────────────────────────────────
// In-memory write-dedupe micro-cache
// ───────────────────────────────────────────────────────────
// CF Workers keep per-isolate module state alive across requests
// within the same isolate. This map tracks the last write timestamp
// per key so concurrent scans from a single user don't hammer KV.
//
// The map is cleared lazily — entries older than WRITE_DEDUPE_MS
// are skipped on read, and stale entries are garbage-collected
// when the map grows past MAX_DEDUPE_ENTRIES.
const WRITE_DEDUPE_MS = 30 * 1000; // 30 seconds
const MAX_DEDUPE_ENTRIES = 500;

const writeDedupeMap = new Map();

// Counter for observability — logged periodically.
let kvWritesSkipped = 0;
let kvWritesCompleted = 0;
let lastSkippedLogAt = 0;
const SKIPPED_LOG_INTERVAL_MS = 60 * 1000;

/**
 * Test hook — reset all module-level state. Use only in tests.
 */
export function _resetCacheState() {
  writeDedupeMap.clear();
  kvWritesSkipped = 0;
  kvWritesCompleted = 0;
  lastSkippedLogAt = 0;
}

/**
 * Test hook — read current counters.
 */
export function _getCacheCounters() {
  return { kvWritesSkipped, kvWritesCompleted, dedupeMapSize: writeDedupeMap.size };
}

/**
 * Determine whether a KV write for `key` should be skipped because
 * the same key was written within the last WRITE_DEDUPE_MS.
 *
 * Also garbage-collects stale dedupe entries when the map grows.
 */
function shouldSkipWrite(key, now = Date.now()) {
  const last = writeDedupeMap.get(key);
  if (last != null && now - last < WRITE_DEDUPE_MS) return true;

  // Lazy GC — if the map is getting big, drop entries older than the dedupe window.
  if (writeDedupeMap.size > MAX_DEDUPE_ENTRIES) {
    for (const [k, ts] of writeDedupeMap) {
      if (now - ts >= WRITE_DEDUPE_MS) writeDedupeMap.delete(k);
    }
  }
  return false;
}

/**
 * Record a successful KV write in the dedupe map.
 */
function recordWrite(key, now = Date.now()) {
  writeDedupeMap.set(key, now);
  kvWritesCompleted += 1;
}

/**
 * Write a value to KV with an envelope `{ value, writtenAt }`. Respects
 * the 30s in-memory dedupe window so concurrent requests don't cause
 * redundant KV writes. Never throws — KV failures are logged.
 *
 * @param {KVNamespace} kv
 * @param {string} key
 * @param {*} value            JSON-serialisable
 * @param {number} expirationTtl seconds (KV minimum is 60)
 * @returns {Promise<boolean>} true if the write happened, false if skipped
 */
export async function kvWriteWithDedupe(kv, key, value, expirationTtl) {
  if (!kv) return false;
  if (shouldSkipWrite(key)) {
    kvWritesSkipped += 1;
    maybeLogSkippedCounter();
    return false;
  }
  const envelope = { value, writtenAt: Date.now() };
  try {
    // KV requires a minimum TTL of 60 seconds. Clamp to be safe.
    const ttl = Math.max(60, Math.round(expirationTtl));
    await kv.put(key, JSON.stringify(envelope), { expirationTtl: ttl });
    recordWrite(key);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`kv_write_failed key=${key} err=${err?.message || err}`);
    return false;
  }
}

function maybeLogSkippedCounter() {
  const now = Date.now();
  if (now - lastSkippedLogAt >= SKIPPED_LOG_INTERVAL_MS) {
    lastSkippedLogAt = now;
    // eslint-disable-next-line no-console
    console.log(`kv_writes_skipped=${kvWritesSkipped} kv_writes_completed=${kvWritesCompleted}`);
  }
}

/**
 * Read a cached envelope `{ value, writtenAt }` from KV.
 * Returns `{ value, writtenAt, ageMs }` on hit, or `null` on miss.
 *
 * Does NOT throw — KV read failures return null so callers can
 * fall through to the upstream fetch.
 */
export async function kvReadEnvelope(kv, key, now = Date.now()) {
  if (!kv) return null;
  try {
    const raw = await kv.get(key, 'json');
    if (!raw || typeof raw !== 'object') return null;
    if (!('value' in raw) || typeof raw.writtenAt !== 'number') return null;
    return {
      value: raw.value,
      writtenAt: raw.writtenAt,
      ageMs: Math.max(0, now - raw.writtenAt),
    };
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────
// IST date + market-hours helpers
// ───────────────────────────────────────────────────────────

// IST is UTC+05:30 — constant offset, no DST.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * Return YYYY-MM-DD string in IST for the given epoch-ms timestamp.
 */
export function istDateString(nowMs = Date.now()) {
  const d = new Date(nowMs + IST_OFFSET_MS);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * True if the current time is within NSE cash-market hours (9:00-15:45 IST).
 * Weekend check is intentionally omitted — an off-hours weekend request
 * will still get the "off-hours" TTL, which is what we want.
 */
export function isMarketHoursIST(nowMs = Date.now()) {
  const d = new Date(nowMs + IST_OFFSET_MS);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const mins = h * 60 + m;
  return mins >= 9 * 60 && mins <= 15 * 60 + 45;
}

// ───────────────────────────────────────────────────────────
// Response helpers — consistent X-Cache header surface
// ───────────────────────────────────────────────────────────

/**
 * Build the per-endpoint cache headers so browsers and the load-test
 * can report fresh/stale/miss/unavailable without latency-based guessing.
 *
 * @param {object} opts
 * @param {'HIT'|'MISS'|'STALE'|'UNAVAILABLE'} opts.status
 * @param {string} opts.key
 * @param {number} [opts.ageMs]
 * @param {string} [opts.cacheSource]  fresh|stale|unavailable|miss (X-Cache-Source extras)
 */
export function cacheHeaders({ status, key, ageMs, cacheSource }) {
  const h = {
    'X-Cache': status,
    'X-Cache-Key': key,
  };
  if (typeof ageMs === 'number' && Number.isFinite(ageMs)) {
    h['X-Cache-Age'] = String(Math.floor(ageMs / 1000));
  }
  if (cacheSource) h['X-Cache-Source'] = cacheSource;
  return h;
}

/**
 * Orchestrate the "KV hit → upstream fetch → stale fallback" flow that
 * `/market/vix`, `/market/fiidii`, `/news/india`, `/news/google`
 * all share.
 *
 * @param {object} opts
 * @param {KVNamespace|null} opts.kv
 * @param {string} opts.key                       KV key
 * @param {number} opts.ttlMs                     How long a fresh value is considered fresh
 * @param {number} opts.staleMaxMs                How long a stale value is still servable on upstream fail
 * @param {() => Promise<any>} opts.fetchFresh    Upstream fetcher — throws on failure, returns payload on success
 * @param {() => any} [opts.unavailablePayload]   Default response if no cache AND upstream fails. If omitted, the error bubbles.
 * @returns {Promise<{ payload: any, status: 'HIT'|'MISS'|'STALE'|'UNAVAILABLE', ageMs: number|null, writeTtlSec: number, key: string, warnMessage?: string }>}
 */
export async function kvCacheFlow(opts) {
  const { kv, key, ttlMs, staleMaxMs, fetchFresh, unavailablePayload } = opts;
  const now = Date.now();

  // 1. Check KV for a fresh entry
  const cached = await kvReadEnvelope(kv, key, now);
  if (cached && cached.ageMs < ttlMs) {
    return {
      payload: cached.value,
      status: 'HIT',
      ageMs: cached.ageMs,
      writeTtlSec: 0,
      key,
    };
  }

  // 2. Upstream fetch
  let fetchErr = null;
  try {
    const fresh = await fetchFresh();
    // Write-through — TTL expressed in seconds for KV (clamp to stale window).
    const writeTtlSec = Math.ceil(Math.max(ttlMs, staleMaxMs) / 1000);
    await kvWriteWithDedupe(kv, key, fresh, writeTtlSec);
    return {
      payload: fresh,
      status: 'MISS',
      ageMs: 0,
      writeTtlSec,
      key,
    };
  } catch (err) {
    fetchErr = err;
  }

  // 3. Upstream failed — fall back to stale cache
  if (cached && cached.ageMs <= staleMaxMs) {
    return {
      payload: cached.value,
      status: 'STALE',
      ageMs: cached.ageMs,
      writeTtlSec: 0,
      key,
      warnMessage: `STALE key=${key} ageMs=${cached.ageMs} upstreamErr=${fetchErr?.message || fetchErr}`,
    };
  }

  // 4. No cache either — either return unavailable sentinel or bubble
  if (typeof unavailablePayload === 'function') {
    return {
      payload: unavailablePayload(),
      status: 'UNAVAILABLE',
      ageMs: null,
      writeTtlSec: 0,
      key,
      warnMessage: `UNAVAILABLE key=${key} upstreamErr=${fetchErr?.message || fetchErr}`,
    };
  }
  throw fetchErr;
}

// ───────────────────────────────────────────────────────────
// TTL computation for each endpoint — exported for tests
// ───────────────────────────────────────────────────────────

// VIX — 1h during market hours, 24h otherwise.
export function vixTtlMs(nowMs = Date.now()) {
  return isMarketHoursIST(nowMs) ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
}
// VIX stale window — 24h max before we refuse to serve stale.
export const VIX_STALE_MAX_MS = 24 * 60 * 60 * 1000;

// FII/DII — 6h everywhere (EOD value only).
export const FIIDII_TTL_MS = 6 * 60 * 60 * 1000;
export const FIIDII_STALE_MAX_MS = 48 * 60 * 60 * 1000;

// Broad Indian news RSS map (Moneycontrol + LiveMint + ET + Business Standard
// merged into one endpoint) — 10min market hours, 60min off-hours.
export function indiaNewsTtlMs(nowMs = Date.now()) {
  return isMarketHoursIST(nowMs) ? 10 * 60 * 1000 : 60 * 60 * 1000;
}
// Up to 4h old snapshot is servable on upstream fail.
export const INDIA_NEWS_STALE_MAX_MS = 4 * 60 * 60 * 1000;

// Google News — 4h fresh, 24h stale max.
export const GOOGLE_NEWS_TTL_MS = 4 * 60 * 60 * 1000;
export const GOOGLE_NEWS_STALE_MAX_MS = 24 * 60 * 60 * 1000;

// ───────────────────────────────────────────────────────────
// Key builders
// ───────────────────────────────────────────────────────────

export function vixKey(nowMs = Date.now()) {
  return `nse_vix_daily:${istDateString(nowMs)}`;
}
export function fiidiiKey(nowMs = Date.now()) {
  return `nse_fiidii_daily:${istDateString(nowMs)}`;
}
export function indiaNewsKey(nowMs = Date.now()) {
  const ttlMs = indiaNewsTtlMs(nowMs);
  const hourBucket = Math.floor(nowMs / ttlMs);
  return `india_news_rss:${hourBucket}`;
}
export function googleNewsKey(symbol, nowMs = Date.now()) {
  return `google_news:${symbol}:${istDateString(nowMs)}`;
}
