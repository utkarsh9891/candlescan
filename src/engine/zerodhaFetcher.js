/**
 * Zerodha Kite Connect API fetcher for OHLCV data.
 * Routes through a Cloudflare Worker proxy at candlescan-proxy.
 * No external dependencies — plain JS only.
 */

import { TokenExpiredError, consumeSimulatedExpiry, isTokenExpiredError } from './brokerErrors.js';
import { createSemaphore, retryWithBackoff } from './rateLimit.js';
import { getCachedChart, setCachedChart } from './chartCacheLocal.js';
import { CF_WORKER_URL } from './transport.js';

// Kite Connect caps historical-data requests at 3 req/sec. Cap at 2
// concurrent for a 33% safety margin. Shared across all callers.
const kiteSemaphore = createSemaphore(2);
/** @internal — exported for tests only. */
export const _kiteSemaphore = kiteSemaphore;

function shouldRetryKite(err) {
  if (!err) return false;
  if (isTokenExpiredError(err)) return false;
  const status = Number(err.status || 0);
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  const msg = String(err.message || '');
  if (/HTTP 429\b/.test(msg)) return true;
  if (/HTTP 5\d\d\b/.test(msg)) return true;
  return false;
}

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

  // localStorage cache — keyed by (symbol, timeframe, today). 24h TTL;
  // browser-only via graceful fallback.
  const cacheDate = toStr;
  const cacheHit = getCachedChart('kite', sym, timeframe, cacheDate);
  if (cacheHit?.candles?.length) {
    return {
      candles: cacheHit.candles,
      live: true,
      simulated: false,
      displaySymbol: sym,
      companyName: sym,
      cached: true,
    };
  }

  try {
    // Dev-only: window.__simulateTokenExpiry('kite') flips a one-shot
    // flag that we consume here so the UI banner can be QA'd without
    // touching a real broker token. No-op in production bundles.
    if (consumeSimulatedExpiry('kite')) {
      throw new TokenExpiredError('kite');
    }
    const data = await kiteSemaphore.run(() =>
      retryWithBackoff(async () => {
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
          // Token-expiry detection for Kite. Kite's canonical signal is
          // HTTP 403 with `error_type: "TokenException"` in the JSON body
          // ("Incorrect api_key or access_token" is the typical message),
          // but we also accept a looser textual fallback so any future
          // wording change doesn't regress this banner to "empty scan".
          // useStockScan.js already uses a similar pattern (/TokenException/i)
          // so we keep the two paths in sync.
          if (res.status === 403 && /TokenException|Incorrect.*(?:api_key|access_token)|token[\s_-]*(?:expired|invalid)/i.test(text)) {
            throw new TokenExpiredError('kite');
          }
          const err = new Error(`HTTP ${res.status}${text ? ': ' + text : ''}`);
          err.status = res.status;
          throw err;
        }
        return res.json();
      }, { retries: 3, baseMs: 500, maxMs: 10_000, shouldRetry: shouldRetryKite })
    );
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

    if (candles.length > 0) {
      try {
        setCachedChart('kite', sym, timeframe, cacheDate, candles);
      } catch { /* best-effort */ }
    }

    return {
      candles,
      live: true,
      simulated: false,
      displaySymbol: sym,
      companyName: sym,
    };
  } catch (err) {
    // Bubble token-expiry so batchScan can short-circuit and surface
    // a reconnect banner. Soft-fail other errors as before.
    if (err instanceof TokenExpiredError) throw err;
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
