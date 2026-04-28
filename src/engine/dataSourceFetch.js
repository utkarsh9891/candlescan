/**
 * Creates a fetch function for the active data source.
 * Returns a function with the same signature as fetchOHLCV:
 *   (symbol, timeframe, options) => Promise<{ candles, live, error, ... }>
 *
 * For Zerodha/Dhan, wraps the provider-specific fetcher with vault/gateToken.
 * Falls back to Yahoo Finance (fetchOHLCV) if credentials are unavailable.
 *
 * On TokenExpiredError, the wrapper clears the vault, flips the persisted
 * data source to 'yahoo', and emits `candlescan:data-source-changed` so
 * React state in App.jsx can re-sync. The error is then re-thrown so
 * batchScan / useStockScan still surface the reconnect banner. Without
 * this self-heal, every subsequent scan in the same session would keep
 * hitting the dead broker token despite the user having no valid path.
 */

import { fetchOHLCV } from './fetcher.js';
import { fetchZerodhaOHLCV } from './zerodhaFetcher.js';
import { fetchDhanOHLCV } from './dhanFetcher.js';
import { getVaultBlob, hasVault, clearVault } from '../utils/credentialVault.js';
import { getGateToken } from '../utils/batchAuth.js';
import { isTokenExpiredError } from './brokerErrors.js';

const LS_SOURCE_KEY = 'candlescan_data_source';

function selfHealOnTokenExpiry() {
  try { clearVault(); } catch { /* ok */ }
  try { localStorage.setItem(LS_SOURCE_KEY, 'yahoo'); } catch { /* ok */ }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try { window.dispatchEvent(new CustomEvent('candlescan:data-source-changed', { detail: { reason: 'token-expired' } })); } catch { /* ok */ }
  }
}

function wrapWithExpiryFallback(innerFetch) {
  return async (symbol, timeframe, opts) => {
    try {
      return await innerFetch(symbol, timeframe, opts);
    } catch (err) {
      if (isTokenExpiredError(err)) {
        selfHealOnTokenExpiry();
      }
      throw err;
    }
  };
}

/**
 * @param {string} dataSource — 'yahoo' | 'zerodha' | 'dhan'
 * @returns {(symbol: string, timeframe: string, options?: object) => Promise<object>}
 */
export function createFetchFn(dataSource) {
  if (dataSource === 'zerodha' && hasVault()) {
    const vault = getVaultBlob();
    const gateToken = getGateToken();
    if (vault && gateToken) {
      return wrapWithExpiryFallback((symbol, timeframe, opts) =>
        fetchZerodhaOHLCV(symbol, timeframe, { ...opts, vault, gateToken })
      );
    }
  }

  if (dataSource === 'dhan' && hasVault()) {
    const vault = getVaultBlob();
    const gateToken = getGateToken();
    if (vault && gateToken) {
      return wrapWithExpiryFallback((symbol, timeframe, opts) =>
        fetchDhanOHLCV(symbol, timeframe, { ...opts, vault, gateToken })
      );
    }
  }

  // Default: Yahoo Finance
  return fetchOHLCV;
}
