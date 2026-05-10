/**
 * Direct Dhan HQ OHLCV fetcher for cockpit scans.
 *
 * Two-step auth:
 *   1. POST https://auth.dhan.co/app/generateAccessToken
 *        ?dhanClientId=&pin=&totp=
 *      → returns { accessToken, dhanClientName, expiryTime }
 *      Done once at cockpit boot via interactive TOTP prompt.
 *
 *   2. POST https://api.dhan.co/v2/charts/intraday
 *      Headers: access-token, client-id
 *      Body:    { securityId, exchangeSegment: 'NSE_EQ', instrument: 'EQUITY',
 *                 expiryCode: 0, oi: false, fromDate, toDate, interval }
 *      → returns { open: [], high: [], low: [], close: [], volume: [], timestamp: [] }
 *
 * Intervals (Dhan, intraday): 1, 5, 15, 25, 60 (minutes, as numbers).
 * Range limit: ~5 days for intraday endpoints.
 *
 * Symbol → securityId resolution uses a 7-day disk cache of Dhan's
 * 32 MB scrip-master CSV.
 */

import { loadInstrumentMap } from './broker-cache.mjs';

const DHAN_AUTH_URL = 'https://auth.dhan.co/app/generateAccessToken';
const DHAN_INTRADAY_URL = 'https://api.dhan.co/v2/charts/intraday';
const DHAN_HISTORICAL_URL = 'https://api.dhan.co/v2/charts/historical';
const SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';
const INSTRUMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const INTERVAL_MAP = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '25m': 25,
  '60m': 60,
  '1h': 60,
};

/**
 * One-shot login. Used at cockpit boot when scan.dataSource === 'dhan'.
 * Prompts user for TOTP via the caller (we just take it as a string).
 */
export async function dhanLogin({ clientId, pin, totp }) {
  if (!clientId || !pin || !totp) {
    throw new Error('dhanLogin requires { clientId, pin, totp }');
  }
  const url =
    `${DHAN_AUTH_URL}?dhanClientId=${encodeURIComponent(clientId)}` +
    `&pin=${encodeURIComponent(pin)}&totp=${encodeURIComponent(totp)}`;
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg;
    try {
      const parsed = JSON.parse(text);
      msg = parsed.remarks || parsed.message || parsed.errorMessage || text.slice(0, 200);
    } catch {
      msg = text.slice(0, 200);
    }
    throw new Error(`dhan auth HTTP ${res.status}: ${msg}`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`dhan returned non-JSON: ${text.slice(0, 200)}`); }
  const accessToken =
    data.accessToken || data.access_token || data.data?.accessToken || data.data?.access_token;
  if (!accessToken) {
    throw new Error(`dhan returned no accessToken; keys: ${Object.keys(data).join(', ')}`);
  }
  return {
    accessToken,
    clientName: data.dhanClientName || data.data?.dhanClientName || '',
    expiryTime: data.expiryTime || data.data?.expiryTime || '',
  };
}

/**
 * Fetch + parse Dhan's NSE scrip master into a symbol → securityId map.
 * Filters to NSE equities + indices only. ~32 MB download.
 */
async function fetchScripMaster() {
  const res = await fetch(SCRIP_MASTER_URL, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`dhan scrip-master HTTP ${res.status}`);
  const csv = await res.text();
  const lines = csv.split('\n');
  const header = lines[0].split(',');
  const exchIdx = header.indexOf('SEM_EXM_EXCH_ID');
  const secIdIdx = header.indexOf('SEM_SMST_SECURITY_ID');
  const symIdx = header.indexOf('SEM_TRADING_SYMBOL');
  const instrIdx = header.indexOf('SEM_INSTRUMENT_NAME');
  const map = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length <= symIdx) continue;
    const exch = (cols[exchIdx] || '').trim();
    const instr = (cols[instrIdx] || '').trim();
    if (exch !== 'NSE' || (instr !== 'EQUITY' && instr !== 'INDEX')) continue;
    const tradingSym = (cols[symIdx] || '').replace(/"/g, '').trim();
    const secId = (cols[secIdIdx] || '').trim();
    if (tradingSym && secId) map[tradingSym] = secId;
  }
  return map;
}

async function getSecurityId(symbol) {
  const map = await loadInstrumentMap('dhan', INSTRUMENT_TTL_MS, fetchScripMaster);
  const id = map[symbol];
  if (!id) throw new Error(`symbol "${symbol}" not in Dhan NSE scrip master`);
  return id;
}

function fmtDhanDate(d) {
  // Dhan accepts YYYY-MM-DD HH:MM:SS in IST.
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
 * @param {string} symbol — NSE equity (e.g. "RELIANCE")
 * @param {string} interval — "1m" | "5m" | "15m" | "60m"
 * @param {string} _range — ignored; we use today−5d → today
 * @param {{ clientId: string, accessToken: string }} ctx — Dhan creds + access token
 */
export async function fetchLiveCandles(symbol, interval = '5m', _range = '5d', ctx) {
  if (!ctx?.clientId || !ctx?.accessToken) {
    throw new Error('dhan fetcher requires { clientId, accessToken }');
  }
  const intMin = INTERVAL_MAP[interval];
  if (intMin == null) throw new Error(`unsupported interval: ${interval}`);

  const securityId = await getSecurityId(symbol);
  const now = new Date();
  const past = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

  const reqBody = {
    securityId: String(securityId),
    exchangeSegment: 'NSE_EQ',
    instrument: 'EQUITY',
    expiryCode: 0,
    oi: false,
    fromDate: fmtDhanDate(past),
    toDate: fmtDhanDate(now),
    interval: intMin,
  };

  const res = await fetch(DHAN_INTRADAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'access-token': ctx.accessToken,
      'client-id': ctx.clientId,
    },
    body: JSON.stringify(reqBody),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg;
    try {
      const parsed = JSON.parse(text);
      msg = parsed.remarks || parsed.message || parsed.errorMessage || text.slice(0, 200);
    } catch { msg = text.slice(0, 200); }
    throw new Error(`dhan intraday HTTP ${res.status}: ${msg}`);
  }
  const data = await res.json();
  const ts = data.timestamp || [];
  const opens = data.open || [];
  const highs = data.high || [];
  const lows = data.low || [];
  const closes = data.close || [];
  const vols = data.volume || [];
  if (!ts.length) return null;

  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const raw = ts[i];
    const tSec = typeof raw === 'number' ? raw : Math.floor(new Date(raw).getTime() / 1000);
    candles.push({
      t: tSec,
      o: opens[i],
      h: highs[i],
      l: lows[i],
      c: closes[i],
      v: vols[i] || 0,
    });
  }
  return { candles, companyName: symbol };
}
