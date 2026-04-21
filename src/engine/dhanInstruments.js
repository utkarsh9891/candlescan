/**
 * Dhan instrument master — client-side cache of symbol → securityId.
 *
 * Architecture:
 *  - On Dhan token connect, the client fetches the full NSE equity map from
 *    the Worker's GET /dhan/instruments endpoint (one 175KB JSON blob).
 *  - Stored in localStorage under LS_KEY, indefinitely (no expiry).
 *  - Every subsequent /dhan/historical call resolves securityId locally and
 *    sends it in the request body — the Worker's hot path never touches KV.
 *  - Settings has a "Refresh Dhan instrument list" button that forces a
 *    re-fetch (used after new NSE listings or if coverage is incomplete).
 *
 * This replaces the previous architecture where the Worker did a per-request
 * KV lookup on a 175KB JSON blob, which was both slow and incomplete (the
 * KV cache had patchy coverage of small-cap names).
 */

import { CF_WORKER_URL } from './transport.js';

const LS_KEY = 'candlescan_dhan_instruments';
const LS_META_KEY = 'candlescan_dhan_instruments_meta';

// Auto-refresh threshold. The Worker's KV cache is 7 days; we trigger a
// background refresh after 5 days so the local copy never drifts past KV's
// TTL. Fires at most once per session via `_autoRefreshFired` below.
const AUTO_REFRESH_AGE_MS = 5 * 24 * 60 * 60 * 1000;
let _autoRefreshFired = false;

/** @internal — exported for tests only. */
export function _resetAutoRefreshFired() {
  _autoRefreshFired = false;
}

/**
 * Read the cached instrument map from localStorage.
 * Also schedules a background refresh if the cache is older than 5 days
 * (to stay ahead of the Worker's 7-day KV TTL). The refresh runs out of
 * band and does not block this call.
 *
 * @returns {Record<string,string> | null}
 */
export function getCachedInstruments() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    maybeScheduleAutoRefresh();
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget refresh when the cached map is older than
 * AUTO_REFRESH_AGE_MS. Requires a gate token stored in localStorage
 * (same key the Settings page uses). If no token is present or the
 * Worker is unreachable we swallow the error silently — the stale
 * map is still usable.
 */
function maybeScheduleAutoRefresh() {
  if (_autoRefreshFired) return;
  const meta = getInstrumentsMeta();
  const fetchedAt = meta?.fetchedAt ? Date.parse(meta.fetchedAt) : 0;
  if (!fetchedAt) return;
  if (Date.now() - fetchedAt < AUTO_REFRESH_AGE_MS) return;

  let gateToken = '';
  try {
    gateToken = localStorage.getItem('candlescan_gate_hash') || '';
  } catch { /* noop */ }
  if (!gateToken) return;

  _autoRefreshFired = true;
  // Detach from the caller's microtask. We don't await this — the stale
  // map stays usable until the refresh completes and overwrites it.
  Promise.resolve().then(() =>
    fetchDhanInstruments(gateToken, { forceRefresh: false }).catch(() => {
      // Permit retry on next session.
      _autoRefreshFired = false;
    })
  );
}

/** @returns {{ count: number, fetchedAt: string } | null} */
export function getInstrumentsMeta() {
  try {
    const raw = localStorage.getItem(LS_META_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Resolve a symbol to its Dhan securityId from the local cache.
 * Returns null if the cache is empty or the symbol isn't known.
 * @param {string} symbol  e.g. 'RELIANCE'
 * @returns {string | null}
 */
export function resolveDhanSecurityId(symbol) {
  const map = getCachedInstruments();
  if (!map) return null;
  const sym = String(symbol || '').trim().toUpperCase().replace(/\.NS$/i, '');
  return map[sym] || null;
}

/**
 * Fetch the full instrument map from the Worker and persist to localStorage.
 * Called once on Dhan token connect, and again if the user manually refreshes.
 *
 * @param {string} gateToken  Premium gate token (SHA-256 hash)
 * @param {{ forceRefresh?: boolean }} [opts]
 * @returns {Promise<{ count: number, generatedAt: string }>}
 */
export async function fetchDhanInstruments(gateToken, { forceRefresh = false } = {}) {
  const url = `${CF_WORKER_URL}/dhan/instruments${forceRefresh ? '?refresh=1' : ''}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'X-Gate-Token': gateToken },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to fetch Dhan instruments: HTTP ${res.status}${text ? ': ' + text : ''}`);
  }
  const data = await res.json();
  if (!data.instruments || typeof data.instruments !== 'object') {
    throw new Error('Invalid response from /dhan/instruments');
  }
  const count = data.count || Object.keys(data.instruments).length;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data.instruments));
    localStorage.setItem(LS_META_KEY, JSON.stringify({
      count,
      fetchedAt: new Date().toISOString(),
      generatedAt: data.generatedAt || null,
    }));
  } catch (e) {
    // localStorage quota — rare given ~175KB payload
    throw new Error(`Failed to cache instruments: ${e.message || e}`);
  }
  return { count, generatedAt: data.generatedAt };
}

/** Remove the cached instrument map (called on Clear Credentials). */
export function clearDhanInstruments() {
  try {
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem(LS_META_KEY);
  } catch { /* ok */ }
}

/** True if we have any cached instruments (even if stale). */
export function hasCachedInstruments() {
  return getCachedInstruments() !== null;
}
