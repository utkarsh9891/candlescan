/**
 * Yahoo Finance v8 chart API + CORS fallbacks.
 * Primary: Cloudflare Worker proxy (candlescan-proxy.workers.dev).
 * Fallback: Jina Reader (r.jina.ai).
 * Simulated OHLCV exists only in Vite dev when the URL has ?simulate=1 (or simulate=true).
 */

const BASE_PRICES = {
  RELIANCE: 2450,
  TCS: 3680,
  INFY: 1520,
  HDFCBANK: 1680,
  SBIN: 720,
  ITC: 420,
  TATAMOTORS: 780,
  WIPRO: 480,
  DEFAULT: 1000,
};

export const TIMEFRAME_MAP = {
  '1m': { interval: '1m', range: '5d' },
  '5m': { interval: '5m', range: '5d' },
  '15m': { interval: '15m', range: '5d' },
  '30m': { interval: '30m', range: '1mo' },
  '1h': { interval: '60m', range: '1mo' },
  '1d': { interval: '1d', range: '6mo' },
};

/**
 * Extended lookback ranges used when the chart user scrolls back near the
 * left edge. Feeds the lazy-prefetch path in Chart.jsx → App.jsx. Level 0
 * is the default (above); higher levels progressively fetch more history.
 * Yahoo's `range` param accepts standard codes; we pick the widest each
 * interval supports without switching granularity.
 */
export const EXTENDED_LOOKBACKS = {
  '1m': ['5d', '7d'],          // 1m data is capped at ~7 days by Yahoo
  '5m': ['5d', '1mo', '2mo'],
  '15m': ['5d', '1mo', '2mo'],
  '30m': ['1mo', '2mo', '3mo'],
  '1h': ['1mo', '3mo', '6mo'],
  '1d': ['6mo', '2y', '5y'],
};

/**
 * Cloudflare Worker URL — deploy worker/ directory, then paste the URL here.
 * Until deployed, leave blank and the app falls through to Jina/public proxies.
 */
export const CF_WORKER_URL = 'https://candlescan-proxy.utkarsh-dev.workers.dev';

function normalizeSymbol(raw) {
  const s = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\.NS$/i, '');
  if (s === 'NIFTY50' || s === 'NIFTY') return '^NSEI';
  if (s === 'BANKNIFTY') return '^NSEBANK';
  if (s.startsWith('^')) return s;
  return `${s}.NS`;
}

function buildYahooUrl(symbol, interval, range) {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
}

function buildDevProxyUrl(symbol, interval, range) {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  return `/__candlescan-yahoo${path}`;
}

/**
 * Build dev proxy URL with period1/period2 for date-specific cache.
 * @param {string} symbol Yahoo symbol
 * @param {string} interval e.g. '1m'
 * @param {string} date YYYY-MM-DD (IST date)
 */
function buildDevProxyUrlForDate(symbol, interval, date) {
  // IST trading day: 09:15 IST = 03:45 UTC, 15:30 IST = 10:00 UTC
  const [y, m, d] = date.split('-').map(Number);
  const dayStart = new Date(Date.UTC(y, m - 1, d, 3, 45, 0));
  const dayEnd = new Date(Date.UTC(y, m - 1, d, 10, 0, 0));
  const p1 = Math.floor(dayStart.getTime() / 1000);
  const p2 = Math.floor(dayEnd.getTime() / 1000);
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&period1=${p1}&period2=${p2}`;
  return `/__candlescan-yahoo${path}`;
}

function isViteDev() {
  try {
    return import.meta.env && import.meta.env.DEV === true;
  } catch {
    return false;
  }
}

/** Dev-only: ?simulate=1 or simulate=true */
function isDevSimulateRequested() {
  if (!isViteDev() || typeof window === 'undefined') return false;
  try {
    const v = new URLSearchParams(window.location.search).get('simulate');
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

/** Production build served over http://127.0.0.1 (or localhost) — local-dev-server.mjs provides /__candlescan-yahoo */
function isProdHttpLoopback() {
  if (typeof window === 'undefined') return false;
  try {
    if (import.meta.env && import.meta.env.DEV === true) return false;
    if (import.meta.env && import.meta.env.PROD !== true) return false;
  } catch {
    return false;
  }
  const p = window.location.protocol;
  if (p !== 'http:') return false;
  const h = (window.location.hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

function parseChartJson(data) {
  const r = data?.chart?.result?.[0];
  if (!r) return null;
  const meta = r.meta || {};
  const companyName =
    meta.longName || meta.shortName || meta.symbol || '';
  const ts = r.timestamp;
  const q = r.indicators?.quote?.[0];
  if (!ts?.length || !q) return null;
  const o = q.open || [];
  const h = q.high || [];
  const l = q.low || [];
  const c = q.close || [];
  const v = q.volume || [];
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const open = o[i];
    const high = h[i];
    const low = l[i];
    const close = c[i];
    if (open == null || high == null || low == null || close == null) continue;
    candles.push({
      t: ts[i],
      o: open,
      h: high,
      l: low,
      c: close,
      v: v[i] != null ? v[i] : 0,
    });
  }
  return candles.length ? { candles, companyName } : null;
}

/**
 * Yahoo often appends a snapshot bar with O≈H≈L≈C (no range). Pattern detection treats
 * the last candle as "current"; zero-range bars prevent engulfing, momentum, hammer, etc.
 */
export function trimTrailingFlatCandles(candles) {
  if (!candles?.length) return candles;
  const out = candles.slice();
  const eps = 1e-6;
  while (out.length > 5 && Math.abs(out[out.length - 1].h - out[out.length - 1].l) < eps) {
    out.pop();
  }
  return out;
}

async function tryFetch(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/**
 * Cloudflare Worker proxy — most reliable path for production.
 * @param {string} yahooUrl
 * @param {string} [gateToken] — optional gate token for authenticated scans
 */
async function tryFetchCfWorker(yahooUrl, gateToken) {
  // Use centralized CF proxy with auto-auth
  const { cfFetchJson } = await import('../utils/cfProxy.js');
  return cfFetchJson(yahooUrl, gateToken);
}

/**
 * r.jina.ai fetches the URL server-side and returns text with a short header; body is raw JSON.
 */
async function tryFetchJinaReader(yahooUrl) {
  const proxyUrl = `https://r.jina.ai/${yahooUrl}`;
  const res = await fetch(proxyUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  const text = await res.text();
  const marker = 'Markdown Content:';
  const i = text.indexOf(marker);
  const slice = (i >= 0 ? text.slice(i + marker.length) : text).trim();
  const j = slice.indexOf('{');
  if (j === -1) throw new Error('no json in jina body');
  return JSON.parse(slice.slice(j));
}

/** Optional build-time proxy: set VITE_CANDLESCAN_PROXY_URL */
function tryFetchFromEnvProxy(yahooUrl) {
  let base;
  try {
    base = import.meta.env && import.meta.env.VITE_CANDLESCAN_PROXY_URL;
  } catch {
    base = '';
  }
  base = typeof base === 'string' ? base.trim() : '';
  if (!base) return null;
  const enc = encodeURIComponent(yahooUrl);
  const url = base.includes('%s') ? base.replace('%s', enc) : `${base}${enc}`;
  return () => tryFetch(url);
}

/** allorigins.win wraps JSON in { contents, status } */
async function tryFetchAllOriginsGet(yahooUrl) {
  const enc = encodeURIComponent(yahooUrl);
  const res = await fetch(
    `https://api.allorigins.win/get?url=${enc}`,
    { cache: 'no-store' }
  );
  if (!res.ok) throw new Error(String(res.status));
  const wrap = await res.json();
  if (wrap.contents == null || wrap.contents === '') throw new Error('empty contents');
  return JSON.parse(typeof wrap.contents === 'string' ? wrap.contents : String(wrap.contents));
}

async function fetchWithFallbacks(symbol, interval, range, options) {
  const yahooUrl = buildYahooUrl(symbol, interval, range);
  const enc = encodeURIComponent(yahooUrl);
  // Token is auto-read from localStorage by cfProxy.js if not explicitly passed
  const gateToken = options?.gateToken || options?.batchToken || '';
  const date = options?.date || null;

  const attempts = [];

  /* Same-origin proxy: Vite dev or local Node server (never CORS issues) */
  if (typeof window !== 'undefined') {
    if (isViteDev() || isProdHttpLoopback()) {
      // Prefer date-specific URL for cache hit when date is provided
      const proxyUrl = date
        ? buildDevProxyUrlForDate(symbol, interval, date)
        : buildDevProxyUrl(symbol, interval, range);
      attempts.push(() =>
        tryFetch(new URL(proxyUrl, window.location.origin).href)
      );
    }
  }

  /* Cloudflare Worker — primary production proxy */
  attempts.push(() => tryFetchCfWorker(yahooUrl, gateToken));

  /* Optional env-var proxy */
  const envProxy = tryFetchFromEnvProxy(yahooUrl);
  if (envProxy) attempts.push(envProxy);

  /* Fallbacks */
  attempts.push(
    () => tryFetchJinaReader(yahooUrl),
    () => tryFetch(`https://api.allorigins.win/raw?url=${enc}`),
    () => tryFetchAllOriginsGet(yahooUrl),
  );

  for (const run of attempts) {
    try {
      const json = await run();
      // If Yahoo returned a valid response structure (has chart.result[0].meta)
      // but no candle data, that's authoritative — don't waste 25s on fallbacks.
      const hasYahooMeta = json?.chart?.result?.[0]?.meta;
      const parsed = parseChartJson(json);
      if (parsed?.candles?.length)
        return { candles: parsed.candles, companyName: parsed.companyName, live: true };
      if (hasYahooMeta)
        return { candles: null, live: false, companyName: hasYahooMeta.longName || hasYahooMeta.shortName || '' };
    } catch {
      /* next */
    }
  }
  return { candles: null, live: false, companyName: '' };
}

function seededRandom(seed) {
  let x = seed % 2147483647;
  if (x <= 0) x += 2147483646;
  return () => {
    x = (x * 16807) % 2147483647;
    return (x - 1) / 2147483646;
  };
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Dev-only demo series when ?simulate=1 (not used in production builds).
 */
export function generateSimulatedCandles(symbol, count = 80) {
  const key = symbol.replace(/[^A-Z]/gi, '').toUpperCase() || 'X';
  const base =
    BASE_PRICES[key] ||
    BASE_PRICES[key.split('.')[0]] ||
    BASE_PRICES.DEFAULT;
  const rnd = seededRandom(hashStr(symbol + count));
  const candles = [];
  let price = base * (0.98 + rnd() * 0.04);
  const cycle = Math.floor(rnd() * 5);

  for (let i = 0; i < count - 5; i++) {
    const drift = (rnd() - 0.48) * base * 0.002;
    const o = price;
    const c = o + drift + (rnd() - 0.5) * base * 0.003;
    const h = Math.max(o, c) + rnd() * base * 0.0015;
    const l = Math.min(o, c) - rnd() * base * 0.0015;
    const v = Math.floor(1e5 + rnd() * 5e5);
    candles.push({ t: Date.now() / 1000 - (count - i) * 60, o, h, l, c, v });
    price = c;
  }

  const lastO = price;
  if (cycle === 0) {
    const c1 = lastO * (1 - 0.004);
    candles.push({
      t: Date.now() / 1000 - 300,
      o: lastO,
      h: lastO * 1.001,
      l: c1 * 0.999,
      c: c1,
      v: 2e5,
    });
    const o2 = c1 * 1.0005;
    const c2 = lastO * 1.003;
    candles.push({
      t: Date.now() / 1000 - 240,
      o: o2,
      h: c2 * 1.002,
      l: o2 * 0.998,
      c: c2,
      v: 3e5,
    });
  } else if (cycle === 1) {
    const body = lastO * 0.003;
    candles.push({
      t: Date.now() / 1000 - 300,
      o: lastO,
      h: lastO + body * 0.2,
      l: lastO - body * 2.2,
      c: lastO + body * 0.1,
      v: 2e5,
    });
    candles.push({
      t: Date.now() / 1000 - 240,
      o: lastO + body * 0.15,
      h: lastO + body * 0.4,
      l: lastO - body * 0.1,
      c: lastO + body * 0.35,
      v: 2e5,
    });
  } else {
    for (let j = 0; j < 5; j++) {
      const o = price;
      const c = o + (rnd() - 0.45) * base * 0.002;
      const h = Math.max(o, c) + rnd() * base * 0.001;
      const l = Math.min(o, c) - rnd() * base * 0.001;
      candles.push({
        t: Date.now() / 1000 - (5 - j) * 60,
        o,
        h,
        l,
        c,
        v: 2e5,
      });
      price = c;
    }
  }

  return candles;
}

/**
 * @param {string} inputSymbol
 * @param {string} timeframeKey
 * @param {{ gateToken?: string, batchToken?: string, date?: string, lookbackLevel?: number }} [options]
 *   date is YYYY-MM-DD for date-partitioned cache;
 *   lookbackLevel (0-based) selects a wider history range from EXTENDED_LOOKBACKS
 *   — used by the chart's lazy-prefetch path when the user scrolls toward
 *   the left edge. 0 = default (same as timeframe map), 1+ = successively
 *   older data.
 * @returns {{ candles: Array, live: boolean, simulated: boolean, error?: string, yahooSymbol: string, displaySymbol: string, companyName: string }}
 */
export async function fetchOHLCV(inputSymbol, timeframeKey, options) {
  const tf = TIMEFRAME_MAP[timeframeKey] || TIMEFRAME_MAP['5m'];
  const yahooSymbol = normalizeSymbol(inputSymbol);
  const displaySymbol = inputSymbol.trim().toUpperCase() || yahooSymbol;

  // Optional extended-lookback override for lazy prefetch.
  // Falls back to the timeframe's default range if level is 0 or invalid.
  const extendedSeries = EXTENDED_LOOKBACKS[timeframeKey] || [];
  const level = Math.max(0, Math.min(extendedSeries.length - 1, Number(options?.lookbackLevel) || 0));
  const rangeOverride = level > 0 && extendedSeries[level] ? extendedSeries[level] : tf.range;

  if (isDevSimulateRequested()) {
    const sim = generateSimulatedCandles(displaySymbol, 90);
    return {
      candles: sim,
      live: false,
      simulated: true,
      yahooSymbol,
      displaySymbol,
      companyName: displaySymbol,
    };
  }

  const { candles, live, companyName: cn } = await fetchWithFallbacks(
    yahooSymbol,
    tf.interval,
    rangeOverride,
    options
  );

  if (candles?.length) {
    const trimmed = trimTrailingFlatCandles(candles);
    return {
      candles: trimmed,
      live,
      simulated: false,
      yahooSymbol,
      displaySymbol,
      companyName: cn || displaySymbol,
    };
  }

  return {
    candles: [],
    live: false,
    simulated: false,
    error:
      'Could not load chart data from Yahoo Finance (network, CORS, or rate limits). Check your connection and try again.',
    yahooSymbol,
    displaySymbol,
    companyName: displaySymbol,
  };
}

/** @internal — exported for unit tests only */
export { normalizeSymbol as _normalizeSymbol, parseChartJson as _parseChartJson };
