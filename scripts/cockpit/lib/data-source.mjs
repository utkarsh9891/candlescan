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
 *   - for Dhan: prompts for TOTP, exchanges for an in-memory access token
 *   - returns the ctx object to pass into every scan tick
 */

import log from '../log.mjs';
import { askSecret } from './prompts.mjs';
import * as yahoo from './yahoo.mjs';
import * as zerodha from './zerodha.mjs';
import * as dhan from './dhan.mjs';

/**
 * @returns {{
 *   name: 'yahoo' | 'dhan' | 'zerodha',
 *   fetchLiveCandles: (sym, interval, range) => Promise<{candles, companyName}|null>
 * }}
 */
export async function setupDataSource(cfg) {
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
    if (!process.stdin.isTTY) {
      throw new Error(
        'scan.dataSource is "dhan" but stdin is not a TTY — Dhan needs an interactive ' +
          'TOTP prompt at every boot. Either run interactively (npm run cockpit) or ' +
          'switch dataSource to yahoo / zerodha for launchd auto-start.',
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
    log.boot(
      `dhan login OK · client="${session.clientName || cfg.dhan.clientId}" ` +
        `expires=${session.expiryTime || '<unknown>'}`,
    );
    const ctx = { clientId: cfg.dhan.clientId, accessToken: session.accessToken };
    return {
      name: 'dhan',
      fetchLiveCandles: (sym, interval, range) => dhan.fetchLiveCandles(sym, interval, range, ctx),
    };
  }

  throw new Error(`unknown scan.dataSource: ${ds}`);
}
