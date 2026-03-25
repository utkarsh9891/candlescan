/**
 * Yahoo Finance v8 chart API + CORS fallbacks.
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
  '1m': { interval: '1m', range: '1d' },
  '5m': { interval: '5m', range: '5d' },
  '15m': { interval: '15m', range: '5d' },
  '30m': { interval: '30m', range: '1mo' },
  '1h': { interval: '60m', range: '1mo' },
  '1d': { interval: '1d', range: '6mo' },
};

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

async function tryFetch(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/** allorigins.win wraps JSON in { contents, status } — sometimes works when /raw fails */
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

/** Third public proxy (Codetabs) — extra fallback on GitHub Pages where direct Yahoo is always CORS-blocked */
async function tryFetchCodetabsProxy(yahooUrl) {
  const res = await fetch(
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(yahooUrl)}`,
    { cache: 'no-store' }
  );
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

async function fetchWithFallbacks(symbol, interval, range) {
  const yahooUrl = buildYahooUrl(symbol, interval, range);
  const enc = encodeURIComponent(yahooUrl);

  const attempts = [];

  /* Same-origin proxy: Vite dev or local Node server (never CORS issues) */
  if (typeof window !== 'undefined') {
    if (isViteDev() || isProdHttpLoopback()) {
      attempts.push(() =>
        tryFetch(new URL(buildDevProxyUrl(symbol, interval, range), window.location.origin).href)
      );
    }
  }

  /**
   * Never call Yahoo directly from the browser on static hosts (e.g. github.io):
   * Yahoo does not send Access-Control-Allow-Origin for our origin — only noisy failed preflights.
   * Public CORS proxies below are the supported path for GitHub Pages.
   */
  attempts.push(
    () => tryFetch(`https://api.allorigins.win/raw?url=${enc}`),
    () => tryFetchAllOriginsGet(yahooUrl),
    () => tryFetch(`https://corsproxy.io/?${enc}`),
    () => tryFetchCodetabsProxy(yahooUrl)
  );

  for (const run of attempts) {
    try {
      const json = await run();
      const parsed = parseChartJson(json);
      if (parsed?.candles?.length)
        return { candles: parsed.candles, companyName: parsed.companyName, live: true };
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
 * @returns {{ candles: Array, live: boolean, simulated: boolean, error?: string, yahooSymbol: string, displaySymbol: string, companyName: string }}
 */
export async function fetchOHLCV(inputSymbol, timeframeKey) {
  const tf = TIMEFRAME_MAP[timeframeKey] || TIMEFRAME_MAP['5m'];
  const yahooSymbol = normalizeSymbol(inputSymbol);
  const displaySymbol = inputSymbol.trim().toUpperCase() || yahooSymbol;

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
    tf.range
  );

  if (candles?.length) {
    return {
      candles,
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
