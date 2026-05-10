/**
 * Direct Kite Connect (Zerodha) OHLCV fetcher for cockpit scans.
 *
 * No CF Worker hop — the cockpit uses the same `apiKey:accessToken`
 * authorization the Worker would use, hits Kite's API directly.
 *
 * Auth: `Authorization: token <api_key>:<access_token>`
 * Header: `X-Kite-Version: 3`
 *
 * Endpoints:
 *   GET /instruments/NSE              → ~3 MB CSV (instrument map)
 *   GET /instruments/historical/{token}/{interval}?from=&to=&continuous=0&oi=0
 *
 * Intervals (Kite naming):
 *   minute, 3minute, 5minute, 10minute, 15minute, 30minute, 60minute, day
 *
 * Range limits (Kite):
 *   minute / 3minute     → 60 days max
 *   5minute / 10minute   → 100 days max
 *   day                  → 2000 days max
 *
 * Cockpit caches the instrument map for 24h on disk.
 */

import { loadInstrumentMap } from './broker-cache.mjs';

const KITE_BASE = 'https://api.kite.trade';
const INSTRUMENT_TTL_MS = 24 * 60 * 60 * 1000;

const INTERVAL_MAP = {
  '1m': 'minute',
  '3m': '3minute',
  '5m': '5minute',
  '10m': '10minute',
  '15m': '15minute',
  '30m': '30minute',
  '60m': '60minute',
  '1h': '60minute',
  '1d': 'day',
};

function authHeader(apiKey, accessToken) {
  return `token ${apiKey}:${accessToken}`;
}

/**
 * Fetch and parse the full NSE instruments CSV from Kite. Returns a
 * map keyed by tradingsymbol → instrument_token (string). Filters to
 * NSE equity rows only.
 */
async function fetchInstrumentsCsv(apiKey, accessToken) {
  const res = await fetch(`${KITE_BASE}/instruments/NSE`, {
    headers: {
      Authorization: authHeader(apiKey, accessToken),
      'X-Kite-Version': '3',
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`kite /instruments/NSE HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const csv = await res.text();
  const lines = csv.split('\n');
  // Header: instrument_token,exchange_token,tradingsymbol,name,last_price,
  //         expiry,strike,tick_size,lot_size,instrument_type,segment,exchange
  const map = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 11) continue;
    const token = cols[0];
    const tradingsymbol = (cols[2] || '').replace(/"/g, '');
    const instrumentType = (cols[9] || '').replace(/"/g, '');
    const segment = (cols[10] || '').replace(/"/g, '');
    // Filter: only NSE cash-market equities (segment "NSE", instrument_type "EQ")
    if (segment !== 'NSE' || instrumentType !== 'EQ') continue;
    if (tradingsymbol && token) map[tradingsymbol] = token;
  }
  return map;
}

/**
 * Get instrument_token for an NSE symbol. Hits the disk-cached map first;
 * downloads from Kite if cache is stale or missing.
 */
async function getInstrumentToken(symbol, { apiKey, accessToken }) {
  const map = await loadInstrumentMap('zerodha', INSTRUMENT_TTL_MS, () =>
    fetchInstrumentsCsv(apiKey, accessToken),
  );
  const token = map[symbol];
  if (!token) throw new Error(`symbol "${symbol}" not in Kite NSE instruments`);
  return token;
}

/**
 * Format a Date as `YYYY-MM-DD HH:MM:SS` in IST (Kite's expected format).
 */
function fmtIstDateTime(d) {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const yyyy = ist.getUTCFullYear();
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const HH = String(ist.getUTCHours()).padStart(2, '0');
  const MM = String(ist.getUTCMinutes()).padStart(2, '0');
  const SS = String(ist.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`;
}

/**
 * Match yahoo.mjs's signature so scan.mjs can swap by config.
 *
 * @param {string} symbol  NSE equity symbol without suffix (e.g. "RELIANCE")
 * @param {string} interval  "1m" | "5m" | "15m" | ...
 * @param {string} _range  ignored — Kite uses explicit from/to; we compute 5 days back.
 * @param {{ apiKey: string, accessToken: string }} ctx  Zerodha creds (decrypted in memory)
 * @returns {Promise<{ candles: Array<{t,o,h,l,c,v}>, companyName: string } | null>}
 */
export async function fetchLiveCandles(symbol, interval = '5m', _range = '5d', ctx) {
  if (!ctx?.apiKey || !ctx?.accessToken) {
    throw new Error('zerodha fetcher requires { apiKey, accessToken }');
  }
  const kiteInterval = INTERVAL_MAP[interval];
  if (!kiteInterval) throw new Error(`unsupported interval: ${interval}`);

  const token = await getInstrumentToken(symbol, ctx);
  const now = new Date();
  const past = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
  const from = fmtIstDateTime(past);
  const to = fmtIstDateTime(now);

  const url =
    `${KITE_BASE}/instruments/historical/${token}/${kiteInterval}` +
    `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: authHeader(ctx.apiKey, ctx.accessToken),
      'X-Kite-Version': '3',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg;
    try { msg = JSON.parse(text).message; } catch { msg = text.slice(0, 200); }
    throw new Error(`kite historical HTTP ${res.status}: ${msg}`);
  }
  const json = await res.json();
  const rows = json?.data?.candles ?? [];
  if (!rows.length) return null;

  const candles = [];
  for (const row of rows) {
    // Kite returns: [timestamp ISO, open, high, low, close, volume]
    const [ts, o, h, l, c, v] = row;
    const tSec = Math.floor(new Date(ts).getTime() / 1000);
    candles.push({ t: tSec, o, h, l, c, v: v ?? 0 });
  }
  return { candles, companyName: symbol };
}
