/**
 * Single source of truth for the Cloudflare Worker URL.
 *
 * Every outbound call to the Worker (passthrough proxy, market context,
 * broker OHLCV, broker auth, gate unlock, instrument master, GitHub
 * releases fallback) goes through this module so any future change —
 * custom domain, BYO-Worker URL, native-shell direct calls, vendor swap
 * — is a single-file edit instead of touching ten callers.
 *
 * The constant is exported as-is for call sites that build their own
 * URLs; `cfUrl(path)` is a thin helper for the common
 * `${CF_WORKER_URL}${path}` pattern.
 */

/**
 * Production Cloudflare Worker endpoint.
 *
 * Kept as a plain string (not env-driven) because the PWA is served from
 * static hosting and there is no build-time way to parametrise this
 * without also shipping a runtime config. When a future plan lands a
 * BYO-Worker escape hatch in Settings, the override logic goes here.
 */
export const CF_WORKER_URL = 'https://candlescan-proxy.utkarsh-dev.workers.dev';

/**
 * Build a Worker URL for a path. Accepts leading-slashed and bare paths
 * symmetrically.
 *
 *   cfUrl('/market/vix')       → 'https://…/market/vix'
 *   cfUrl('market/vix')        → 'https://…/market/vix'
 *   cfUrl('/news/google?symbol=RELIANCE')
 *                              → 'https://…/news/google?symbol=RELIANCE'
 *
 * @param {string} path
 * @returns {string}
 */
export function cfUrl(path) {
  if (!path) return CF_WORKER_URL;
  const p = String(path);
  return p.startsWith('/') ? `${CF_WORKER_URL}${p}` : `${CF_WORKER_URL}/${p}`;
}
