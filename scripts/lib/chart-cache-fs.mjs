/**
 * Local Yahoo v8 chart JSON on disk — dev / batch / validation (not used in production HTTPS).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
export const CHART_CACHE_DIR = path.join(REPO_ROOT, 'cache', 'charts');

/** Default 7d; set CANDLESCAN_CHART_CACHE_MAX_AGE_MS=0 to ignore mtime (use file until deleted). */
export function getChartCacheMaxAgeMs() {
  const v = process.env.CANDLESCAN_CHART_CACHE_MAX_AGE_MS;
  if (v === '0' || v === '') return 0;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 7 * 24 * 60 * 60 * 1000;
}

export function chartCacheFilePath(yahooSymbol, interval, range) {
  const safe = String(yahooSymbol).replace(/[^a-zA-Z0-9._^-]/g, '_');
  return path.join(CHART_CACHE_DIR, `${safe}_${interval}_${range}.json`);
}

/**
 * @param {number} maxAgeMs 0 = never expire by age
 * @returns {object|null} raw Yahoo chart JSON
 */
export function readCachedChartJson(yahooSymbol, interval, range, maxAgeMs = getChartCacheMaxAgeMs()) {
  const p = chartCacheFilePath(yahooSymbol, interval, range);
  if (!fs.existsSync(p)) return null;
  if (maxAgeMs > 0) {
    const { mtimeMs } = fs.statSync(p);
    if (Date.now() - mtimeMs > maxAgeMs) return null;
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeCachedChartJson(yahooSymbol, interval, range, chartJson) {
  fs.mkdirSync(CHART_CACHE_DIR, { recursive: true });
  const p = chartCacheFilePath(yahooSymbol, interval, range);
  fs.writeFileSync(p, JSON.stringify(chartJson), 'utf8');
}

/**
 * Parse GET path like /__candlescan-yahoo/v8/finance/chart/RELIANCE.NS?interval=5m&range=5d
 * @param {string} urlPathWithQuery req.url
 */
export function parseYahooDevChartRequest(urlPathWithQuery) {
  try {
    const u = new URL(urlPathWithQuery, 'http://127.0.0.1');
    const m = u.pathname.match(/\/__candlescan-yahoo\/v8\/finance\/chart\/(.+)$/);
    if (!m) return null;
    const symbol = decodeURIComponent(m[1]);
    const interval = u.searchParams.get('interval') || '5m';
    const range = u.searchParams.get('range') || '5d';
    if (!symbol) return null;
    return { symbol, interval, range };
  } catch {
    return null;
  }
}
