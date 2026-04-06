/**
 * Centralized Cloudflare Worker proxy layer.
 * All CF Worker API calls go through here — auth token is automatically attached.
 * Prevents the recurring issue of individual callers forgetting to send the token.
 */

import { CF_WORKER_URL } from '../engine/fetcher.js';

const HASH_RE = /^[a-f0-9]{64}$/;

/** Read the stored auth token (SHA-256 hash) from localStorage. */
function getToken() {
  try {
    const t = typeof localStorage !== 'undefined' ? localStorage.getItem('candlescan_gate_hash') : '';
    return t && HASH_RE.test(t) ? t : '';
  } catch {
    return '';
  }
}

/**
 * Fetch via the Cloudflare Worker proxy with automatic auth.
 * @param {string} targetUrl — the upstream URL to proxy (Yahoo, NSE, etc.)
 * @param {string} [explicitToken] — override token (e.g., from batch scan)
 * @returns {Promise<Response>}
 */
export async function cfFetch(targetUrl, explicitToken) {
  if (!CF_WORKER_URL) throw new Error('CF_WORKER_URL not configured');

  const url = `${CF_WORKER_URL}?url=${encodeURIComponent(targetUrl)}`;
  const headers = {};
  const token = explicitToken || getToken();
  if (token && HASH_RE.test(token)) headers['X-Gate-Token'] = token;

  return fetch(url, { cache: 'no-store', headers });
}

/**
 * Fetch JSON via the Cloudflare Worker proxy with automatic auth.
 * Throws on non-OK responses.
 */
export async function cfFetchJson(targetUrl, explicitToken) {
  const res = await cfFetch(targetUrl, explicitToken);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}
