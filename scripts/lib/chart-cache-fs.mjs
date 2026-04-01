/**
 * Date-partitioned Yahoo v8 chart JSON on disk — dev / batch / validation.
 *
 * Structure: cache/charts/{SYMBOL}/{interval}/{YYYY-MM-DD}.json
 * Each file contains one trading day's OHLCV for one symbol at one interval.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
export const CHART_CACHE_DIR = path.join(REPO_ROOT, 'cache', 'charts');

const IST_OFFSET = 19800; // +5:30 in seconds

/** Convert unix timestamp to IST date string YYYY-MM-DD. */
export function unixToIstDate(ts) {
  return new Date((ts + IST_OFFSET) * 1000).toISOString().slice(0, 10);
}

/**
 * Build cache file path: cache/charts/{SYMBOL}/{interval}/{YYYY-MM-DD}.json
 * @param {string} yahooSymbol e.g. "RELIANCE.NS"
 * @param {string} interval e.g. "1m"
 * @param {string} date YYYY-MM-DD
 */
export function chartCacheFilePath(yahooSymbol, interval, date) {
  const safe = String(yahooSymbol).replace(/[^a-zA-Z0-9._^-]/g, '_');
  return path.join(CHART_CACHE_DIR, safe, interval, `${date}.json`);
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
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write chart JSON for a specific date.
 * @param {string} yahooSymbol
 * @param {string} interval
 * @param {string} date YYYY-MM-DD
 * @param {object} chartJson raw Yahoo chart JSON
 */
export function writeCachedChartJson(yahooSymbol, interval, date, chartJson) {
  const p = chartCacheFilePath(yahooSymbol, interval, date);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(chartJson), 'utf8');
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
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
    .sort();
}

/**
 * List all cached symbols (top-level directories in cache/charts/).
 * @returns {string[]}
 */
export function listCachedSymbols() {
  if (!fs.existsSync(CHART_CACHE_DIR)) return [];
  return fs.readdirSync(CHART_CACHE_DIR)
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
