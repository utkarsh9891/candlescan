/**
 * Fetch Yahoo chart JSON for every symbol in an NSE index and write date-partitioned cache files.
 *
 *   npm run cache:charts -- 5m
 *   npm run cache:charts -- 5m --index "NIFTY 50"
 *
 * Fetches the latest data (range-based) and splits into per-date cache files.
 */

import { DEFAULT_NSE_INDEX_ID } from '../src/config/nseIndices.js';
import { TIMEFRAME_MAP } from '../src/engine/fetcher.js';
import { writeCachedChartJson, unixToIstDate } from './lib/chart-cache-fs.mjs';
import { fetchNseIndexSymbolsNode } from './lib/nse-http.mjs';

const CF_WORKER_URL = 'https://candlescan-proxy.utkarsh-dev.workers.dev';

function parseArgs(argv) {
  let tfKey = '5m';
  let indexName = DEFAULT_NSE_INDEX_ID;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--index' && argv[i + 1]) {
      indexName = argv[i + 1];
      i++;
      continue;
    }
    if (a.startsWith('--')) continue;
    tfKey = a;
  }
  return { tfKey, indexName };
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

async function fetchChartJson(symbol, interval, range) {
  const yahooUrl = buildYahooUrl(symbol, interval, range);
  const url = `${CF_WORKER_URL}?url=${encodeURIComponent(yahooUrl)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json?.chart?.result?.[0]?.timestamp?.length) throw new Error('empty chart');
  return json;
}

async function main() {
  const { tfKey, indexName } = parseArgs(process.argv.slice(2));
  const tf = TIMEFRAME_MAP[tfKey] || TIMEFRAME_MAP['5m'];

  console.log(`\nNSE index: ${indexName}`);
  const stocks = await fetchNseIndexSymbolsNode(indexName);
  console.log(`Symbols: ${stocks.length} | Timeframe: ${tfKey} (${tf.interval} / ${tf.range})\n`);

  let ok = 0;
  let fail = 0;
  let dateFiles = 0;
  const BATCH = 8;

  for (let i = 0; i < stocks.length; i += BATCH) {
    const slice = stocks.slice(i, i + BATCH);
    await Promise.all(
      slice.map(async (stock) => {
        const sym = normalizeSymbol(stock);
        try {
          const json = await fetchChartJson(sym, tf.interval, tf.range);
          const count = cacheByDate(sym, tf.interval, json);
          dateFiles += count;
          ok++;
        } catch (e) {
          console.warn(`  skip ${stock}: ${e.message || e}`);
          fail++;
        }
      })
    );
    process.stdout.write(`  ${Math.min(i + BATCH, stocks.length)}/${stocks.length}\r`);
    if (i + BATCH < stocks.length) await sleep(600);
  }

  console.log(`\n\nDone. Cached: ${ok} symbols (${dateFiles} date files), failed: ${fail}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
