/**
 * Zerodha Kite Connect API fetcher for OHLCV data.
 * Routes through a Cloudflare Worker proxy at candlescan-proxy.
 * No external dependencies — plain JS only.
 */

const CF_WORKER_URL = 'https://candlescan-proxy.utkarsh-dev.workers.dev';

/** Map user-facing timeframe labels to Kite Connect interval strings. */
const KITE_INTERVAL_MAP = {
  '1m': 'minute',
  '5m': '5minute',
  '15m': '15minute',
  '30m': '30minute',
  '1h': '60minute',
  '1d': 'day',
};

/** Maximum lookback in days for each Kite interval (Kite historical data limits). */
const LOOKBACK_DAYS = {
  minute: 60,
  '5minute': 100,
  '15minute': 200,
  '30minute': 200,
  '60minute': 400,
  day: 2000,
};

/**
 * Format a Date as YYYY-MM-DD.
 */
function formatDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Parse a Kite-style date string (e.g. "2024-06-01T09:15:00+0530") to unix seconds.
 */
function parseDateToUnix(dateStr) {
  const ts = new Date(dateStr).getTime();
  return Math.floor(ts / 1000);
}

/**
 * Fetch OHLCV candles from Zerodha via the CF Worker proxy.
 *
 * @param {string} symbol   NSE symbol without suffix, e.g. 'RELIANCE'
 * @param {string} timeframe  One of '1m','5m','15m','30m','1h','1d'
 * @param {object} opts
 * @param {string} opts.vault      Encrypted credentials blob (base64)
 * @param {string} opts.gateToken  SHA-256 hash for auth
 * @returns {Promise<object>}  { candles, live, simulated, displaySymbol, companyName } or { candles:[], error, displaySymbol }
 */
export async function fetchZerodhaOHLCV(symbol, timeframe, { vault, gateToken }) {
  const sym = String(symbol || '').trim().toUpperCase().replace(/\.NS$/i, '');
  const interval = KITE_INTERVAL_MAP[timeframe];

  if (!interval) {
    return {
      candles: [],
      error: `Unsupported timeframe: ${timeframe}`,
      displaySymbol: sym,
    };
  }

  // Calculate date range
  const lookback = LOOKBACK_DAYS[interval];
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - lookback);

  const toStr = formatDate(today);
  const fromStr = formatDate(from);

  try {
    const res = await fetch(`${CF_WORKER_URL}/zerodha/historical`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gate-Token': gateToken,
      },
      body: JSON.stringify({
        symbol: sym,
        interval,
        from: fromStr,
        to: toStr,
        vault,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? ': ' + text : ''}`);
    }

    const data = await res.json();
    const rawCandles = data.candles || [];

    // Normalize from Kite format [date, o, h, l, c, v] to { t, o, h, l, c, v }
    const candles = rawCandles.map(([date, o, h, l, c, v]) => ({
      t: parseDateToUnix(date),
      o,
      h,
      l,
      c,
      v,
    }));

    return {
      candles,
      live: true,
      simulated: false,
      displaySymbol: sym,
      companyName: sym,
    };
  } catch (err) {
    return {
      candles: [],
      error: err.message || 'Zerodha fetch failed',
      displaySymbol: sym,
    };
  }
}

/**
 * Check whether Zerodha credentials (vault blob) exist in localStorage.
 * Safe to call in any environment — returns false when localStorage is unavailable.
 */
export function isZerodhaConfigured() {
  try {
    const vault = localStorage.getItem('candlescan_vault');
    return Boolean(vault);
  } catch {
    return false;
  }
}
