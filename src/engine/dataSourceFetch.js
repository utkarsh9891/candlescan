/**
 * Creates a fetch function for the active data source.
 * Returns a function with the same signature as fetchOHLCV:
 *   (symbol, timeframe, options) => Promise<{ candles, live, error, ... }>
 *
 * For Zerodha/Dhan, wraps the provider-specific fetcher with vault/gateToken.
 * Falls back to Yahoo Finance (fetchOHLCV) if credentials are unavailable.
 */

import { fetchOHLCV } from './fetcher.js';
import { fetchZerodhaOHLCV } from './zerodhaFetcher.js';
import { fetchDhanOHLCV } from './dhanFetcher.js';
import { getVaultBlob, hasVault } from '../utils/credentialVault.js';
import { getGateToken } from '../utils/batchAuth.js';

/**
 * @param {string} dataSource — 'yahoo' | 'zerodha' | 'dhan'
 * @returns {(symbol: string, timeframe: string, options?: object) => Promise<object>}
 */
export function createFetchFn(dataSource) {
  if (dataSource === 'zerodha' && hasVault()) {
    const vault = getVaultBlob();
    const gateToken = getGateToken();
    if (vault && gateToken) {
      return (symbol, timeframe, opts) =>
        fetchZerodhaOHLCV(symbol, timeframe, { ...opts, vault, gateToken });
    }
  }

  if (dataSource === 'dhan' && hasVault()) {
    const vault = getVaultBlob();
    const gateToken = getGateToken();
    if (vault && gateToken) {
      return (symbol, timeframe, opts) =>
        fetchDhanOHLCV(symbol, timeframe, { ...opts, vault, gateToken });
    }
  }

  // Default: Yahoo Finance
  return fetchOHLCV;
}
