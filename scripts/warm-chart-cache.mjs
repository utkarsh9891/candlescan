/**
 * Fetch Yahoo chart JSON for every symbol in an NSE index and write cache/charts/*.json
 *
 *   npm run cache:charts -- 5m
 *   npm run cache:charts -- 5m --index "NIFTY 50"
 */

import { DEFAULT_NSE_INDEX_ID } from '../src/config/nseIndices.js';
import { TIMEFRAME_MAP } from '../src/engine/fetcher.js';
import { writeCachedChartJson } from './lib/chart-cache-fs.mjs';
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
  const BATCH = 8;

  for (let i = 0; i < stocks.length; i += BATCH) {
    const slice = stocks.slice(i, i + BATCH);
    await Promise.all(
      slice.map(async (stock) => {
        const sym = normalizeSymbol(stock);
        try {
          const json = await fetchChartJson(sym, tf.interval, tf.range);
          writeCachedChartJson(sym, tf.interval, tf.range, json);
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

  console.log(`\n\nDone. Cached: ${ok}, failed: ${fail}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
