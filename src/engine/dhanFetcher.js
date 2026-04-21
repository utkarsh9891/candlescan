/**
 * Dhan HQ API fetcher for OHLCV data.
 * Routes through a Cloudflare Worker proxy at candlescan-proxy.
 * Symbol → securityId resolution happens client-side via dhanInstruments.js
 * (local cache populated on token connect) — the Worker hot path never does
 * a KV lookup.
 */

import { resolveDhanSecurityId, hasCachedInstruments } from './dhanInstruments.js';
import { TokenExpiredError, consumeSimulatedExpiry, isTokenExpiredError } from './brokerErrors.js';
import { createSemaphore, retryWithBackoff } from './rateLimit.js';
import { getCachedChart, setCachedChart } from './chartCacheLocal.js';

// Dhan enforces 10 req/sec, 250 req/min on the historical endpoint. Cap at
// 5 concurrent as a 50% safety margin — matches the warm-chart-cache pattern
// of batching without bursting. Shared across all callers in the process.
const dhanSemaphore = createSemaphore(5);
/** @internal — exported for tests only. */
export const _dhanSemaphore = dhanSemaphore;

// Token-expiry errors must never be retried — they surface a reconnect
// banner. Also skip retries on 4xx other than 429.
function shouldRetryDhan(err) {
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

  // Resolve symbol → securityId from local cache. If the cache isn't populated,
  // surface an actionable error asking the user to refresh the instrument list
  // (Settings → Dhan → Refresh instrument list).
  if (!hasCachedInstruments()) {
    return {
      candles: [],
      error: 'Dhan instrument list not loaded. Open Settings → Dhan → Refresh instrument list.',
      displaySymbol: sym,
    };
  }
  const securityId = resolveDhanSecurityId(sym);
  if (!securityId) {
    return {
      candles: [],
      error: `Symbol "${sym}" not in Dhan NSE instrument master.`,
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

  // localStorage cache — keyed by (symbol, interval, today YYYY-MM-DD).
  // Browser-only (no-op in Node via graceful fallback). TTL 24h; same-day
  // re-scans skip the network. Key includes today's date so the cache
  // naturally rotates without manual invalidation.
  const cacheDate = formatDate(today, false);
  const cacheHit = getCachedChart('dhan', sym, timeframe, cacheDate);
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
    // Dev-only: window.__simulateTokenExpiry('dhan') flips a one-shot
    // flag that we consume here so the UI banner can be QA'd without
    // touching a real broker token. No-op in production bundles.
    if (consumeSimulatedExpiry('dhan')) {
      throw new TokenExpiredError('dhan');
    }
    const reqBody = {
      symbol: sym,
      securityId,
      interval,
      from: fromStr,
      to: toStr,
      vault,
      dhanClientId: (() => { try { return localStorage.getItem('candlescan_dhan_client_id') || ''; } catch { return ''; } })(),
    };
    const bodyStr = JSON.stringify(reqBody);
    // Run under the Dhan semaphore with 429/5xx retry. Token-expiry is
    // propagated without retry via shouldRetryDhan so the reconnect
    // banner fires on the first failure.
    const data = await dhanSemaphore.run(() =>
      retryWithBackoff(async () => {
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
          // Token-expiry detection. Dhan surfaces expired / invalid tokens as
          // HTTP 401 (and occasionally 403). The Worker forwards Dhan's
          // original status + error body verbatim, so we also match on
          // broker-specific markers in the message: `DH-901` (invalid
          // token — empirically the most common), `DH-904` (kill-switch),
          // and textual fallbacks ("Invalid_Authentication", "token expired",
          // "unauthorized"). Widened on purpose so a future Dhan code change
          // doesn't silently regress this banner to "empty scan".
          const tokenMarkerRe = /DH-90[14]|Invalid_Authentication|token[\s_-]*(?:expired|invalid)|unauthori[sz]ed/i;
          if (res.status === 401 || (res.status === 403 && tokenMarkerRe.test(text)) || tokenMarkerRe.test(text)) {
            throw new TokenExpiredError('dhan');
          }
          const err = new Error(`HTTP ${res.status}${text ? ': ' + text : ''}`);
          err.status = res.status;
          throw err;
        }

        return res.json();
      }, { retries: 3, baseMs: 500, maxMs: 10_000, shouldRetry: shouldRetryDhan })
    );
    const candles = data.candles || [];

    // Cache non-empty results under today's date key (24h TTL).
    if (candles.length > 0) {
      try {
        setCachedChart('dhan', sym, timeframe, cacheDate, candles);
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
    // Re-throw token-expiry so batchScan can short-circuit and surface
    // a reconnect banner. Other errors keep the existing soft-fail
    // contract (empty candles + error string) so one bad symbol
    // doesn't kill an entire index scan.
    if (err instanceof TokenExpiredError) throw err;
    return {
      candles: [],
      error: `Dhan fetch failed: ${err.message || err}`,
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
