/**
 * Data-source dispatcher for the cockpit's scan loop.
 *
 * Returns a fetcher matching cfg.scan.dataSource. All fetchers share
 * the same shape:
 *
 *   fetchLiveCandles(symbol, interval, range, ctx)
 *     → { candles: [{ t, o, h, l, c, v }], companyName } | null
 *
 * Boot-time auth is handled by setupDataSource() which:
 *   - validates creds are present in cfg
 *   - for Dhan: reuses a cached access token if still valid (skip TOTP),
 *     else prompts for TOTP, exchanges via dhanLogin(), then persists
 *     the fresh token (encrypted via gateKey) back to secrets.json
 *   - returns the ctx object to pass into every scan tick
 */

import log from '../log.mjs';
import { askSecret } from './prompts.mjs';
import { readSecrets, writeSecrets } from './secrets-rw.mjs';
import { encrypt } from './gate.mjs';
import * as yahoo from './yahoo.mjs';
import * as zerodha from './zerodha.mjs';
import * as dhan from './dhan.mjs';

// Refresh the cached Dhan token when it expires in less than this. Dhan's
// expiry is 24h; a 5-min safety margin avoids the case where the token
// expires mid-scan and every symbol fetch fails.
const DHAN_REFRESH_SAFETY_SEC = 5 * 60;

/** Parse Dhan's `expiryTime` (ISO string or epoch ms/s) → epoch seconds. */
function parseExpiry(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') {
    return raw > 1e12 ? Math.floor(raw / 1000) : raw;
  }
  const t = Date.parse(raw);
  if (!Number.isNaN(t)) return Math.floor(t / 1000);
  return null;
}

/** Returns { accessToken, expiresAt } if cached token is still valid, else null. */
function readCachedDhanToken(cfg) {
  const token = cfg.dhan?.accessToken;
  const expiresAt = cfg.dhan?.accessTokenExpiresAt;
  if (!token || !expiresAt) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (expiresAt < nowSec + DHAN_REFRESH_SAFETY_SEC) return null;
  return { accessToken: token, expiresAt };
}

/**
 * Read the raw (still-encrypted) secrets.json, patch in the new Dhan
 * access token + expiry, write back atomically. The gateKey is required
 * — broker creds can't exist without a gate (see commands/dhan.mjs).
 */
function persistDhanTokenCache({ accessToken, expiresAt, gateKey }) {
  if (!gateKey) {
    throw new Error('cannot cache Dhan access token without a gate key');
  }
  const raw = readSecrets();
  raw.dhan = {
    ...(raw.dhan || {}),
    accessToken: encrypt(accessToken, gateKey),
    accessTokenExpiresAt: expiresAt,
  };
  writeSecrets(raw);
}

/**
 * @returns {{
 *   name: 'yahoo' | 'dhan' | 'zerodha',
 *   fetchLiveCandles: (sym, interval, range) => Promise<{candles, companyName}|null>
 * }}
 */
export async function setupDataSource(cfg, gateKey = null) {
  const ds = cfg.scan?.dataSource || 'yahoo';

  if (ds === 'yahoo') {
    return {
      name: 'yahoo',
      fetchLiveCandles: (sym, interval, range) => yahoo.fetchLiveCandles(sym, interval, range),
    };
  }

  if (ds === 'zerodha') {
    if (!cfg.zerodha?.apiKey || !cfg.zerodha?.accessToken) {
      throw new Error(
        'scan.dataSource is "zerodha" but zerodha.apiKey + zerodha.accessToken are not set. ' +
          'Run:  npm run cockpit:zerodha',
      );
    }
    log.boot(
      `data source: zerodha · apiKey=${cfg.zerodha.apiKey.slice(0, 6)}…  ` +
        `accessToken=<${cfg.zerodha.accessToken.length}-char>`,
    );
    const ctx = { apiKey: cfg.zerodha.apiKey, accessToken: cfg.zerodha.accessToken };
    return {
      name: 'zerodha',
      fetchLiveCandles: (sym, interval, range) => zerodha.fetchLiveCandles(sym, interval, range, ctx),
    };
  }

  if (ds === 'dhan') {
    if (!cfg.dhan?.clientId || !cfg.dhan?.pin) {
      throw new Error(
        'scan.dataSource is "dhan" but dhan.clientId + dhan.pin are not set. ' +
          'Run:  npm run cockpit:dhan',
      );
    }

    // ── Path 1: cached token still valid → skip TOTP ──
    const cached = readCachedDhanToken(cfg);
    if (cached) {
      const hoursLeft = Math.max(0, Math.floor((cached.expiresAt - Date.now() / 1000) / 3600));
      log.boot(
        `data source: dhan · clientId=${cfg.dhan.clientId} · ` +
          `using cached access token (≈${hoursLeft}h left)`,
      );
      const ctx = { clientId: cfg.dhan.clientId, accessToken: cached.accessToken };
      return {
        name: 'dhan',
        fetchLiveCandles: (sym, interval, range) => dhan.fetchLiveCandles(sym, interval, range, ctx),
      };
    }

    // ── Path 2: no cache, expired, or close to expiring → prompt TOTP ──
    if (!process.stdin.isTTY) {
      throw new Error(
        'scan.dataSource is "dhan" and no valid cached access token. Need an interactive ' +
          'TOTP prompt to refresh, but stdin is not a TTY. Run interactively or wait until ' +
          'the next interactive boot.',
      );
    }
    log.boot(`data source: dhan · clientId=${cfg.dhan.clientId} — TOTP required`);
    process.stdout.write('\nDhan auth: enter the current 6-digit TOTP from your authenticator app.\n');
    const totp = await askSecret('TOTP', { minLength: 6 });
    log.boot('exchanging clientId + PIN + TOTP for access token...');
    const session = await dhan.dhanLogin({
      clientId: cfg.dhan.clientId,
      pin: cfg.dhan.pin,
      totp,
    });
    const expiresAt =
      parseExpiry(session.expiryTime) ||
      // Dhan tokens are valid for ~24h. Default to 23h from now if the
      // login response doesn't carry a usable expiry.
      Math.floor(Date.now() / 1000) + 23 * 3600;
    log.boot(
      `dhan login OK · client="${session.clientName || cfg.dhan.clientId}" ` +
        `expires=${new Date(expiresAt * 1000).toISOString()}`,
    );

    try {
      persistDhanTokenCache({
        accessToken: session.accessToken,
        expiresAt,
        gateKey,
      });
      log.boot('dhan: access token cached (encrypted) — subsequent boots will skip the TOTP prompt');
    } catch (e) {
      // Persist failure is non-fatal; the in-memory token still works
      // for this boot, just won't be reused next time.
      log.warn(`dhan: failed to cache access token (${e.message}) — TOTP needed next boot`);
    }

    const ctx = { clientId: cfg.dhan.clientId, accessToken: session.accessToken };
    return {
      name: 'dhan',
      fetchLiveCandles: (sym, interval, range) => dhan.fetchLiveCandles(sym, interval, range, ctx),
    };
  }

  throw new Error(`unknown scan.dataSource: ${ds}`);
}
