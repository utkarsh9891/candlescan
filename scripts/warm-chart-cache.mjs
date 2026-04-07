/**
 * Fetch Yahoo chart JSON for every symbol in an NSE index and write date-partitioned cache files.
 *
 * Usage:
 *   npm run cache:charts                                  # default: 5m, default index
 *   npm run cache:charts -- 5m                            # specific timeframe
 *   npm run cache:charts -- 5m --index "NIFTY TOTAL MARKET"
 *   npm run cache:charts -- --all-timeframes              # warm 1m, 5m, 15m in sequence
 *   npm run cache:charts -- --all-timeframes --index "NIFTY TOTAL MARKET"
 *
 * Fetches directly from Yahoo Finance (no CF worker proxy — avoids rate limits).
 *
 * Key learnings & design notes:
 *
 * 1. DIRECT YAHOO FETCH — Previously routed through the CF worker proxy which has
 *    a 20 req/day rate limit for unauthenticated users. Fetching directly from
 *    query1.finance.yahoo.com avoids this entirely. A browser-like User-Agent header
 *    is required to avoid Yahoo rejecting requests.
 *
 * 2. THROTTLING — Yahoo rate-limits aggressive concurrent requests. Batch size of 3
 *    with 1s delay between batches works reliably for 700+ symbol runs.
 *    Batch=8 with 600ms caused HTTP 429s after ~150 symbols.
 *
 * 3. TIMEFRAME RANGES — Yahoo's intraday data retention:
 *      - 1m:  max 8 days per request, only last 30 calendar days available.
 *            range=8d gets the maximum. range=1mo returns an error.
 *            period-based requests older than 30 days are also rejected.
 *      - 5m:  ~60 days (range=1mo gives full month)
 *      - 15m: ~60 days (range=1mo gives full month)
 *    For initial cache population, run 5m/15m with range=1mo first, then 1m with 8d.
 *    For daily top-ups, range=5d is sufficient for all timeframes.
 *
 * 4. SYMBOL EDGE CASES — Symbols with '&' (M&M, GVT&D, J&KBANK, ARE&M, GMRP&UI)
 *    get URL-encoded for Yahoo and sanitized to '_' on disk (chartCacheFilePath).
 *    Both directions work transparently — no special handling needed.
 *
 * 5. NIFTY TOTAL MARKET — ~750 stocks. Full warm run takes ~5 min per timeframe.
 *    The NSE API for fetching index constituents can be flaky; if it fails, retry.
 *
 * 6. CACHE SCHEMA — Each file is a complete Yahoo v8 chart JSON envelope:
 *    { chart: { result: [{ meta, timestamp, indicators: { quote: [...] } }], error: null } }
 *    Stored at: cache/charts/{SYMBOL}/{interval}/{YYYY-MM-DD}.json
 */

import { DEFAULT_NSE_INDEX_ID } from '../src/config/nseIndices.js';
import { TIMEFRAME_MAP } from '../src/engine/fetcher.js';
import { writeCachedChartJson, unixToIstDate, listCachedDates } from './lib/chart-cache-fs.mjs';
import { fetchNseIndexSymbolsNode } from './lib/nse-http.mjs';

const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** Conservative batch settings — proven reliable for 700+ symbol runs. */
const BATCH_SIZE = 3;
const BATCH_DELAY_MS = 1000;

function parseArgs(argv) {
  let tfKey = '5m';
  let indexName = DEFAULT_NSE_INDEX_ID;
  let allTimeframes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--index' && argv[i + 1]) {
      indexName = argv[i + 1];
      i++;
      continue;
    }
    if (a === '--all-timeframes') {
      allTimeframes = true;
      continue;
    }
    if (a.startsWith('--')) continue;
    tfKey = a;
  }
  return { tfKey, indexName, allTimeframes };
}

function normalizeSymbol(raw) {
  const s = String(raw).trim().toUpperCase().replace(/\.NS$/i, '');
  if (s.startsWith('^')) return s;
  return `${s}.NS`;
}

function buildYahooUrl(symbol, interval, range) {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Split Yahoo chart JSON into per-date cache files.
 * Overwrites existing files for the same date (ensures latest data wins).
 */
function cacheByDate(symbol, interval, json) {
  const r = json?.chart?.result?.[0];
  if (!r?.timestamp?.length) return 0;
  const ts = r.timestamp;
  const q = r.indicators?.quote?.[0];
  if (!q) return 0;

  const dateGroups = {};
  for (let i = 0; i < ts.length; i++) {
    const date = unixToIstDate(ts[i]);
    if (!dateGroups[date]) dateGroups[date] = [];
    dateGroups[date].push(i);
  }

  let count = 0;
  for (const [date, indices] of Object.entries(dateGroups)) {
    const dateTs = indices.map(i => ts[i]);
    const dateQuote = {
      open: indices.map(i => q.open?.[i] ?? null),
      high: indices.map(i => q.high?.[i] ?? null),
      low: indices.map(i => q.low?.[i] ?? null),
      close: indices.map(i => q.close?.[i] ?? null),
      volume: indices.map(i => q.volume?.[i] ?? null),
    };
    const dateJson = {
      chart: {
        result: [{
          meta: r.meta,
          timestamp: dateTs,
          indicators: { quote: [dateQuote] },
        }],
        error: null,
      },
    };
    writeCachedChartJson(symbol, interval, date, dateJson);
    count++;
  }
  return count;
}

/**
 * Fetch chart data directly from Yahoo Finance.
 * No CF worker proxy — avoids daily rate limits entirely.
 */
async function fetchChartJson(symbol, interval, range) {
  const url = buildYahooUrl(symbol, interval, range);
  const res = await fetch(url, {
    headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json?.chart?.result?.[0]?.timestamp?.length) throw new Error('empty chart');
  return json;
}

/**
 * Warm cache for a single timeframe.
 * @param {string[]} stocks — raw NSE symbols (without .NS)
 * @param {string} interval — Yahoo interval (1m, 5m, 15m)
 * @param {string} range — Yahoo range (5d, 1mo)
 * @param {string} label — display label for progress
 */
async function warmTimeframe(stocks, interval, range, label) {
  console.log(`\n--- ${label}: ${interval} / ${range} (${stocks.length} symbols) ---`);

  let ok = 0;
  let fail = 0;
  let dateFiles = 0;

  for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
    const slice = stocks.slice(i, i + BATCH_SIZE);
    await Promise.all(
      slice.map(async (stock) => {
        const sym = normalizeSymbol(stock);
        try {
          const json = await fetchChartJson(sym, interval, range);
          const count = cacheByDate(sym, interval, json);
          dateFiles += count;
          ok++;
        } catch (e) {
          console.warn(`  skip ${stock}: ${e.message || e}`);
          fail++;
        }
      })
    );
    process.stdout.write(`  ${Math.min(i + BATCH_SIZE, stocks.length)}/${stocks.length} (ok:${ok} fail:${fail})\r`);
    if (i + BATCH_SIZE < stocks.length) await sleep(BATCH_DELAY_MS);
  }

  console.log(`\n  Done: ${ok} cached (${dateFiles} date files), ${fail} failed`);
  return { ok, fail, dateFiles };
}

async function main() {
  const { tfKey, indexName, allTimeframes } = parseArgs(process.argv.slice(2));

  console.log(`\nNSE index: ${indexName}`);
  const stocks = await fetchNseIndexSymbolsNode(indexName);
  console.log(`Symbols: ${stocks.length}`);

  if (allTimeframes) {
    // Warm all 3 intraday timeframes in sequence.
    // 5m and 15m use range=1mo to maximize historical depth (~60 days).
    // 1m: max 8 days per request, only last 30 calendar days available on Yahoo.
    const runs = [
      { interval: '5m',  range: '1mo' },
      { interval: '15m', range: '1mo' },
      { interval: '1m',  range: '8d' },
    ];

    let totalOk = 0, totalFail = 0, totalFiles = 0;
    for (const { interval, range } of runs) {
      const r = await warmTimeframe(stocks, interval, range, indexName);
      totalOk += r.ok;
      totalFail += r.fail;
      totalFiles += r.dateFiles;
    }

    console.log(`\n=== All timeframes done. Total: ${totalOk} cached, ${totalFail} failed, ${totalFiles} date files ===\n`);
  } else {
    const tf = TIMEFRAME_MAP[tfKey] || TIMEFRAME_MAP['5m'];
    await warmTimeframe(stocks, tf.interval, tf.range, indexName);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
