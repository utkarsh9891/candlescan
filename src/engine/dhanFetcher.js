/**
 * Dhan HQ API fetcher for OHLCV data.
 * Routes through a Cloudflare Worker proxy at candlescan-proxy.
 * No external dependencies — plain JS only.
 */

const CF_WORKER_URL = 'https://candlescan-proxy.utkarsh-dev.workers.dev';

/** Map user-facing timeframe labels to Dhan interval strings. */
const DHAN_INTERVAL_MAP = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '25m': '25',
  '1h': '60',
  '1d': 'day',
};

/**
 * Initial lookback in days per interval.
 * Kept small for fast initial load — lazy prefetch will extend on scroll.
 * Dhan allows max 90 days per intraday request.
 */
const LOOKBACK_DAYS = {
  '1': 5,     // ~1875 candles (5 trading days × 375 min)
  '5': 15,    // ~1125 candles
  '15': 30,   // ~750 candles
  '25': 45,   // ~675 candles
  '60': 60,   // ~375 candles
  day: 365,   // ~250 candles
};

/** Format a Date as YYYY-MM-DD or YYYY-MM-DD HH:mm:ss for intraday. */
function formatDate(d, intraday = false) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  if (!intraday) return `${yyyy}-${mm}-${dd}`;
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

/**
 * Fetch OHLCV candles from Dhan via the CF Worker proxy.
 *
 * @param {string} symbol   NSE symbol without suffix, e.g. 'RELIANCE'
 * @param {string} timeframe  One of '1m','5m','15m','25m','1h','1d'
 * @param {object} opts
 * @param {string} opts.vault      Encrypted credentials blob (base64)
 * @param {string} opts.gateToken  SHA-256 hash for auth
 * @returns {Promise<object>}
 */
export async function fetchDhanOHLCV(symbol, timeframe, { vault, gateToken }) {
  const sym = String(symbol || '').trim().toUpperCase().replace(/\.NS$/i, '');
  const interval = DHAN_INTERVAL_MAP[timeframe];

  if (!interval) {
    return {
      candles: [],
      error: `Unsupported timeframe for Dhan: ${timeframe}`,
      displaySymbol: sym,
    };
  }

  const isIntraday = interval !== 'day';
  const lookback = LOOKBACK_DAYS[interval];
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - lookback);

  const toStr = formatDate(today, isIntraday);
  const fromStr = formatDate(from, isIntraday);

  try {
    const reqBody = {
      symbol: sym,
      interval,
      from: fromStr,
      to: toStr,
      vault,
      dhanClientId: (() => { try { return localStorage.getItem('candlescan_dhan_client_id') || ''; } catch { return ''; } })(),
    };
    const bodyStr = JSON.stringify(reqBody);
    // Debug: log body size to help diagnose "Failed to fetch"
    if (typeof console !== 'undefined') {
      console.log(`[Dhan] POST /dhan/historical — body: ${bodyStr.length} bytes, symbol: ${sym}, interval: ${interval}, vault: ${vault ? vault.length + ' chars' : 'MISSING'}`);
    }
    const res = await fetch(`${CF_WORKER_URL}/dhan/historical`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gate-Token': gateToken,
      },
      body: bodyStr,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? ': ' + text : ''}`);
    }

    const data = await res.json();
    const candles = data.candles || [];

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
      error: `Dhan fetch failed: ${err.message || err}${err.stack ? ' | ' + err.stack.split('\n')[1]?.trim() : ''}`,
      displaySymbol: sym,
    };
  }
}

/** Supported timeframes for Dhan. */
export const DHAN_TIMEFRAMES = ['1m', '5m', '15m', '25m', '1h', '1d'];

/**
 * Check whether Dhan credentials exist in the vault.
 */
export function isDhanConfigured() {
  try {
    const vault = localStorage.getItem('candlescan_vault');
    return Boolean(vault);
  } catch {
    return false;
  }
}
