/**
 * Date-partitioned Yahoo v8 chart JSON on disk — dev / batch / validation.
 *
 * Structure: <CACHE_ROOT>/charts/{SYMBOL}/{interval}/{YYYY-MM-DD}.json.gz
 * Each file contains one trading day's gzipped OHLCV for one symbol at one
 * interval. Gzip cuts on-disk size ~6-8x for these JSON payloads with a
 * sub-millisecond decompression cost — see scripts/migrate-cache-to-gzip.mjs
 * for the one-shot migration that converted the original .json files.
 *
 * CACHE_ROOT defaults to the sibling candlescan-cache repo. See cache-root.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CACHE_ROOT } from './cache-root.mjs';

export const CHART_CACHE_DIR = path.join(CACHE_ROOT, 'charts');

const IST_OFFSET = 19800; // +5:30 in seconds
const FILE_EXT = '.json.gz';

/** Convert unix timestamp to IST date string YYYY-MM-DD. */
export function unixToIstDate(ts) {
  return new Date((ts + IST_OFFSET) * 1000).toISOString().slice(0, 10);
}

/**
 * Build cache file path: cache/charts/{SYMBOL}/{interval}/{YYYY-MM-DD}.json.gz
 * @param {string} yahooSymbol e.g. "RELIANCE.NS"
 * @param {string} interval e.g. "1m"
 * @param {string} date YYYY-MM-DD
 */
export function chartCacheFilePath(yahooSymbol, interval, date) {
  const safe = String(yahooSymbol).replace(/[^a-zA-Z0-9._^-]/g, '_');
  return path.join(CHART_CACHE_DIR, safe, interval, `${date}${FILE_EXT}`);
}

/**
 * Read cached chart JSON for a specific date.
 * @param {string} yahooSymbol
 * @param {string} interval
 * @param {string} date YYYY-MM-DD
 * @returns {object|null} raw Yahoo chart JSON
 */
export function readCachedChartJson(yahooSymbol, interval, date) {
  const p = chartCacheFilePath(yahooSymbol, interval, date);
  if (!fs.existsSync(p)) return null;
  try {
    const buf = zlib.gunzipSync(fs.readFileSync(p));
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Write chart JSON for a specific date. Stored gzipped to keep the cache
 * repo small enough to clone quickly. Atomic — writes to a tmp file then
 * renames so a crash mid-write never leaves a half-written entry.
 * @param {string} yahooSymbol
 * @param {string} interval
 * @param {string} date YYYY-MM-DD
 * @param {object} chartJson raw Yahoo chart JSON
 */
export function writeCachedChartJson(yahooSymbol, interval, date, chartJson) {
  const p = chartCacheFilePath(yahooSymbol, interval, date);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const buf = zlib.gzipSync(JSON.stringify(chartJson));
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, p);
}

/**
 * List all cached dates for a symbol+interval.
 * @returns {string[]} sorted YYYY-MM-DD strings
 */
export function listCachedDates(yahooSymbol, interval) {
  const safe = String(yahooSymbol).replace(/[^a-zA-Z0-9._^-]/g, '_');
  const dir = path.join(CHART_CACHE_DIR, safe, interval);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(FILE_EXT))
    .map(f => f.slice(0, -FILE_EXT.length))
    .sort();
}

/**
 * List all cached symbols (top-level directories in cache/charts/).
 * Filters to valid NSE/Yahoo symbol shapes (starts with A-Z, 0-9, or `^`),
 * so stray tool directories like `.claude` don't leak into symbol iteration.
 * Digit-leading symbols like `3MINDIA.NS` and `360ONE.NS` are real NSE tickers.
 * @returns {string[]}
 */
export function listCachedSymbols() {
  if (!fs.existsSync(CHART_CACHE_DIR)) return [];
  return fs.readdirSync(CHART_CACHE_DIR)
    .filter(f => /^[A-Z0-9^]/.test(f))
    .filter(f => fs.statSync(path.join(CHART_CACHE_DIR, f)).isDirectory());
}

/**
 * Parse GET path like:
 *   /__candlescan-yahoo/v8/finance/chart/RELIANCE.NS?interval=1m&period1=1742522700&period2=1742545200
 *   /__candlescan-yahoo/v8/finance/chart/RELIANCE.NS?interval=5m&range=5d
 * @param {string} urlPathWithQuery req.url
 * @returns {{ symbol: string, interval: string, date?: string, period1?: number, period2?: number, range?: string } | null}
 */
export function parseYahooDevChartRequest(urlPathWithQuery) {
  try {
    const u = new URL(urlPathWithQuery, 'http://127.0.0.1');
    const m = u.pathname.match(/\/__candlescan-yahoo\/v8\/finance\/chart\/(.+)$/);
    if (!m) return null;
    const symbol = decodeURIComponent(m[1]);
    const interval = u.searchParams.get('interval') || '5m';
    if (!symbol) return null;

    const p1 = u.searchParams.get('period1');
    const p2 = u.searchParams.get('period2');
    if (p1 && p2) {
      const period1 = Number(p1);
      const period2 = Number(p2);
      const date = unixToIstDate(period1);
      return { symbol, interval, date, period1, period2 };
    }

    const range = u.searchParams.get('range') || '5d';
    return { symbol, interval, range };
  } catch {
    return null;
  }
}
