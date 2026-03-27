/**
 * Batch-test NSE index constituents through the CandleScan engine.
 *
 * Yahoo data: by default uses cache/charts (see cache/charts/README.md), then network on miss.
 *
 * Usage:
 *   node scripts/batch-test.mjs [timeframe] [--index "NIFTY 200"]
 *   --no-chart-cache   Never read/write disk (always live Yahoo)
 *   --refresh-charts   Ignore cache reads; refetch and overwrite files
 *
 *   timeframe: 1m, 5m (default), 15m, 30m, 1h, 1d
 */

import { DEFAULT_NSE_INDEX_ID } from '../src/config/nseIndices.js';
import { detectPatterns } from '../src/engine/patterns.js';
import { detectLiquidityBox } from '../src/engine/liquidityBox.js';
import { computeRiskScore } from '../src/engine/risk.js';
import { trimTrailingFlatCandles } from '../src/engine/fetcher.js';
import { fetchNseIndexSymbolsNode } from './lib/nse-http.mjs';
import {
  readCachedChartJson,
  writeCachedChartJson,
  getChartCacheMaxAgeMs,
} from './lib/chart-cache-fs.mjs';

const TIMEFRAME_MAP = {
  '1m': { interval: '1m', range: '1d' },
  '5m': { interval: '5m', range: '5d' },
  '15m': { interval: '15m', range: '5d' },
  '30m': { interval: '30m', range: '1mo' },
  '1h': { interval: '60m', range: '1mo' },
  '1d': { interval: '1d', range: '6mo' },
};

const CF_WORKER_URL = 'https://candlescan-proxy.utkarsh-dev.workers.dev';

function parseArgs(argv) {
  const flags = new Set(argv.filter((x) => x.startsWith('--')));
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
  return {
    tfKey,
    indexName,
    chartCache: !flags.has('--no-chart-cache'),
    refreshCharts: flags.has('--refresh-charts'),
  };
}

function normalizeSymbol(raw) {
  const s = String(raw).trim().toUpperCase().replace(/\.NS$/i, '');
  if (s.startsWith('^')) return s;
  return `${s}.NS`;
}

function buildYahooUrl(symbol, interval, range) {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
}

function parseChartJson(data) {
  const r = data?.chart?.result?.[0];
  if (!r) return null;
  const meta = r.meta || {};
  const companyName = meta.longName || meta.shortName || meta.symbol || '';
  const ts = r.timestamp;
  const q = r.indicators?.quote?.[0];
  if (!ts?.length || !q) return null;
  const o = q.open || [],
    h = q.high || [],
    l = q.low || [],
    c = q.close || [],
    v = q.volume || [];
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    if (o[i] == null || h[i] == null || l[i] == null || c[i] == null) continue;
    candles.push({ t: ts[i], o: o[i], h: h[i], l: l[i], c: c[i], v: v[i] ?? 0 });
  }
  return candles.length ? { candles, companyName } : null;
}

async function fetchCandles(symbol, interval, range, { chartCache, refreshCharts }) {
  const maxAge = getChartCacheMaxAgeMs();

  if (chartCache && !refreshCharts) {
    const disk = readCachedChartJson(symbol, interval, range, maxAge);
    if (disk) {
      const parsed = parseChartJson(disk);
      if (parsed?.candles?.length) return parsed;
    }
  }

  const yahooUrl = buildYahooUrl(symbol, interval, range);
  let json;
  try {
    const url = `${CF_WORKER_URL}?url=${encodeURIComponent(yahooUrl)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      json = await res.json();
    }
  } catch {}
  if (!json) {
    try {
      const url = `https://api.allorigins.win/raw?url=${encodeURIComponent(yahooUrl)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.ok) json = await res.json();
    } catch {}
  }
  if (!json) return null;

  const parsed = parseChartJson(json);
  if (parsed?.candles?.length && chartCache) {
    try {
      writeCachedChartJson(symbol, interval, range, json);
    } catch {
      /* disk full etc. */
    }
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const { tfKey, indexName, chartCache, refreshCharts } = parseArgs(process.argv.slice(2));
  const tf = TIMEFRAME_MAP[tfKey] || TIMEFRAME_MAP['5m'];

  console.log(`\nLoading NSE constituents: ${indexName}…`);
  const STOCKS = await fetchNseIndexSymbolsNode(indexName);

  console.log(`\n=== CandleScan Batch Test ===`);
  console.log(`Timeframe: ${tfKey} (interval=${tf.interval}, range=${tf.range})`);
  console.log(`Index: ${indexName} (${STOCKS.length} symbols)`);
  console.log(
    `Chart cache: ${chartCache ? (refreshCharts ? 'refresh (ignore reads)' : `on (max age ${getChartCacheMaxAgeMs() || '∞'} ms)`) : 'off'}`
  );
  console.log('');

  const results = {
    'STRONG BUY': [],
    BUY: [],
    SHORT: [],
    'STRONG SHORT': [],
    WAIT: [],
    'NO TRADE': [],
    FETCH_ERROR: [],
  };

  const patternStats = { total: 0, withPatterns: 0, withDirectional: 0 };
  const allDetails = [];

  const BATCH = 10;
  for (let i = 0; i < STOCKS.length; i += BATCH) {
    const batch = STOCKS.slice(i, i + BATCH);
    const promises = batch.map(async (stock) => {
      const yahooSym = normalizeSymbol(stock);
      const data = await fetchCandles(yahooSym, tf.interval, tf.range, { chartCache, refreshCharts });
      if (!data) {
        results.FETCH_ERROR.push(stock);
        return;
      }

      const candles = trimTrailingFlatCandles(data.candles);
      patternStats.total++;

      const patterns = detectPatterns(candles);
      const box = detectLiquidityBox(candles);
      const risk = computeRiskScore({ candles, patterns, box });

      if (patterns.length > 0) patternStats.withPatterns++;
      const hasDirectional = patterns.some((p) => p.direction !== 'neutral');
      if (hasDirectional) patternStats.withDirectional++;

      const action = risk.action;
      results[action] = results[action] || [];
      results[action].push(stock);

      allDetails.push({
        stock,
        action,
        confidence: risk.confidence,
        patterns: patterns.length,
        topPattern: patterns[0]?.name || 'none',
        topDirection: patterns[0]?.direction || 'n/a',
        topStrength: patterns[0]?.strength?.toFixed(2) || 'n/a',
        rr: risk.rr?.toFixed(1),
        context: risk.context,
      });
    });

    await Promise.all(promises);
    process.stdout.write(`  Processed ${Math.min(i + BATCH, STOCKS.length)}/${STOCKS.length}\r`);
    if (i + BATCH < STOCKS.length) await sleep(500);
  }

  console.log('\n');

  console.log('=== ACTION SUMMARY ===');
  for (const [action, stocks] of Object.entries(results)) {
    if (stocks.length > 0) {
      console.log(`  ${action.padEnd(14)} : ${stocks.length} stocks`);
    }
  }

  const tradeable = [
    ...results['STRONG BUY'],
    ...results.BUY,
    ...results.SHORT,
    ...results['STRONG SHORT'],
  ];
  console.log(`\n=== TRADEABLE SIGNALS (${tradeable.length}) ===`);
  if (tradeable.length === 0) {
    console.log('  (none)');
  } else {
    for (const d of allDetails.filter((d) => ['STRONG BUY', 'BUY', 'SHORT', 'STRONG SHORT'].includes(d.action))) {
      console.log(
        `  ${d.stock.padEnd(14)} ${d.action.padEnd(14)} conf=${d.confidence} pat=${d.topPattern} str=${d.topStrength} R:R=${d.rr} ctx=${d.context}`
      );
    }
  }

  console.log(`\n=== PATTERN DETECTION ===`);
  console.log(`  Stocks with data     : ${patternStats.total}`);
  console.log(`  With any pattern     : ${patternStats.withPatterns} (${((patternStats.withPatterns / patternStats.total) * 100).toFixed(0)}%)`);
  console.log(`  With directional pat : ${patternStats.withDirectional} (${((patternStats.withDirectional / patternStats.total) * 100).toFixed(0)}%)`);

  if (results.WAIT.length > 0) {
    console.log(`\n=== WAIT SIGNALS (${results.WAIT.length}) ===`);
    for (const d of allDetails.filter((d) => d.action === 'WAIT')) {
      console.log(`  ${d.stock.padEnd(14)} conf=${d.confidence} pat=${d.topPattern}(${d.topDirection}) str=${d.topStrength}`);
    }
  }

  if (results['NO TRADE'].length > 0) {
    console.log(`\n=== NO TRADE BREAKDOWN (${results['NO TRADE'].length}) ===`);
    const noTradeDetails = allDetails.filter((d) => d.action === 'NO TRADE');
    const noPat = noTradeDetails.filter((d) => d.patterns === 0);
    const hasPat = noTradeDetails.filter((d) => d.patterns > 0);
    console.log(`  No patterns detected : ${noPat.length}`);
    console.log(`  Has patterns (low cf): ${hasPat.length}`);
    if (hasPat.length > 0) {
      for (const d of hasPat) {
        console.log(`    ${d.stock.padEnd(14)} conf=${d.confidence} pat=${d.topPattern}(${d.topDirection})`);
      }
    }
  }

  if (results.FETCH_ERROR.length > 0) {
    console.log(`\n=== FETCH ERRORS (${results.FETCH_ERROR.length}) ===`);
    console.log(`  ${results.FETCH_ERROR.join(', ')}`);
  }

  console.log('\n=== SIMPLE vs ADVANCED MODE (app) ===');
  console.log('  Same risk.action from computeRiskScore in both modes.');
  console.log('  Advanced adds quote book, engine stats copy, timer, liquidity/pattern/OHLC blocks.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
