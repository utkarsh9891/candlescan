/**
 * Shared broker-error types.
 *
 * Phase A P1 #8 — a broker token expiring used to surface as a generic
 * "fetch failed" inside batchScan, which silently swallowed it and
 * returned zero results. Users saw an empty scan with no explanation
 * and no call to action.
 *
 * TokenExpiredError is a typed error that the fetchers throw when they
 * detect a token-expiry response (HTTP 401/403 + broker-specific body
 * markers). batchScan catches it specially, short-circuits the scan,
 * and surfaces a `tokenError` field to the UI so a reconnect banner
 * can render above the (possibly partial) results.
 *
 * The `.code` field is the machine-readable discriminator used in
 * tests and debug logs: TOKEN_EXPIRED_DHAN or TOKEN_EXPIRED_KITE.
 */

export class TokenExpiredError extends Error {
  constructor(broker) {
    super(`${broker} token expired`);
    this.name = 'TokenExpiredError';
    this.code = `TOKEN_EXPIRED_${String(broker).toUpperCase()}`;
    this.broker = String(broker).toLowerCase();
  }
}

/** Type-guard helper that's safe across JS realms. */
export function isTokenExpiredError(err) {
  if (!err) return false;
  if (err instanceof TokenExpiredError) return true;
  return typeof err.code === 'string' && err.code.startsWith('TOKEN_EXPIRED_');
}

/**
 * Internal dev-only switch. When set to 'dhan' or 'kite', the matching
 * fetcher throws TokenExpiredError on its next call and then self-clears.
 * Toggled via window.__simulateTokenExpiry() below — lets you preview
 * the reconnect banner in dev without actually invalidating a real token.
 */
let _simulatedExpiryBroker = null;

/** Called by the fetchers to check + consume the one-shot dev flag. */
export function consumeSimulatedExpiry(broker) {
  if (_simulatedExpiryBroker && _simulatedExpiryBroker === broker) {
    _simulatedExpiryBroker = null;
    return true;
  }
  return false;
}

// Dev-only: expose a window helper so the banner can be QA'd without
// an actual broker round-trip. Gated on import.meta.env.DEV so it
// never ships to the production bundle.
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  window.__simulateTokenExpiry = (broker) => {
    const b = String(broker || '').toLowerCase();
    if (b !== 'dhan' && b !== 'kite') {
      // eslint-disable-next-line no-console
      console.warn('[brokerErrors] __simulateTokenExpiry(broker): broker must be "dhan" or "kite"');
      return;
    }
    _simulatedExpiryBroker = b;
    // eslint-disable-next-line no-console
    console.info(`[brokerErrors] Next ${b} fetch will throw TokenExpiredError (one-shot).`);
  };
}
