/**
 * Fetch NSE index constituents (CORS-safe: dev proxy / CF worker / fallbacks).
 */
import { CF_WORKER_URL } from './fetcher.js';
import { NSE_EQUITY_INDICES_BASE } from '../config/nseIndices.js';
import { parseNseIndexSymbols } from './nseIndexParse.js';

function isViteDev() {
  try {
    return import.meta.env && import.meta.env.DEV === true;
  } catch {
    return false;
  }
}

/** Built app on http://127.0.0.1 — sibling `local-dev-server.mjs` mirrors Vite NSE proxy. */
function isProdHttpLoopback() {
  if (typeof window === 'undefined') return false;
  try {
    if (import.meta.env && import.meta.env.DEV === true) return false;
    if (import.meta.env && import.meta.env.PROD !== true) return false;
  } catch {
    return false;
  }
  if (window.location.protocol !== 'http:') return false;
  const h = (window.location.hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

function buildNseUrl(indexName) {
  const q = encodeURIComponent(indexName);
  return `${NSE_EQUITY_INDICES_BASE}?index=${q}`;
}

function devProxyUrl(indexName) {
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/candlescan/';
  const prefix = base.endsWith('/') ? base.slice(0, -1) : base;
  const q = encodeURIComponent(indexName);
  return `${prefix}/__candlescan-nse/api/equity-stockIndices?index=${q}`;
}

async function tryFetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

async function tryAllOrigins(targetUrl) {
  const enc = encodeURIComponent(targetUrl);
  const res = await fetch(`https://api.allorigins.win/raw?url=${enc}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('allorigins');
  return res.json();
}

/**
 * @param {string} indexName e.g. "NIFTY 200"
 * @returns {Promise<string[]>}
 */
export async function fetchNseIndexSymbolList(indexName) {
  const target = buildNseUrl(indexName);
  const attempts = [];

  if (typeof window !== 'undefined' && (isViteDev() || isProdHttpLoopback())) {
    attempts.push(() => tryFetchJson(devProxyUrl(indexName)));
  }

  if (typeof window !== 'undefined' && CF_WORKER_URL) {
    attempts.push(async () => {
      const { cfFetchJson } = await import('../utils/cfProxy.js');
      return cfFetchJson(target);
    });
  }

  attempts.push(() => tryAllOrigins(target));

  let lastErr;
  for (const run of attempts) {
    try {
      const json = await run();
      const syms = parseNseIndexSymbols(json);
      if (syms.length) return syms;
      lastErr = new Error('empty symbol list');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('NSE fetch failed');
}
