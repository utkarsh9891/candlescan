/**
 * Bar-by-bar intraday trading simulation using v2 engine.
 * NO LOOKAHEAD: at bar T, only candles[0..T] are visible.
 *
 * Usage:
 *   node scripts/simulate-day.mjs [timeframe] [--index "NIFTY 50"]
 *   Default: 5m timeframe, NIFTY 50 index
 *
 * Rules:
 *   - Capital: Rs.3,00,000
 *   - Max 5 concurrent positions, Rs.60,000 each
 *   - Entry: signal bar close + 0.1% slippage (built into v2 engine)
 *   - Exit: SL hit, target hit, or EOD (3:15 PM)
 *   - Transaction cost: 0.05% per side
 *   - Skip first 3 bars (15 min cool-off on 5m)
 *   - Skip stocks with avg volume < 50,000
 *   - Only act on confidence >= 65 and actionable signals
 */

import { detectPatterns } from '../src/engine/patterns-v2.js';
import { detectLiquidityBox } from '../src/engine/liquidityBox-v2.js';
import { computeRiskScore } from '../src/engine/risk-v2.js';
import { trimTrailingFlatCandles } from '../src/engine/fetcher.js';
import { fetchNseIndexSymbolsNode } from './lib/nse-http.mjs';
import { readCachedChartJson, writeCachedChartJson } from './lib/chart-cache-fs.mjs';
import { DEFAULT_NSE_INDEX_ID } from '../src/config/nseIndices.js';

const TIMEFRAME_MAP = {
  '1m': { interval: '1m', range: '1d' },
  '5m': { interval: '5m', range: '5d' },
  '15m': { interval: '15m', range: '5d' },
};

const CAPITAL = 300000;
const MAX_POSITIONS = 5;
const POSITION_SIZE = CAPITAL / MAX_POSITIONS; // 60,000
const TX_COST_PCT = 0.0005; // 0.05% per side
const MIN_CONFIDENCE = 65;
const SKIP_FIRST_BARS = 3; // skip first 15 min on 5m
const MIN_AVG_VOLUME = 50000;
const ACTIONABLE = new Set(['STRONG BUY', 'BUY', 'STRONG SHORT', 'SHORT']);

function parseArgs() {
  const args = process.argv.slice(2);
  let timeframe = '5m';
  let indexName = 'NIFTY 50';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--index' && args[i + 1]) { indexName = args[++i]; continue; }
    if (TIMEFRAME_MAP[args[i]]) timeframe = args[i];
  }
  return { timeframe, indexName };
}

function parseChartJson(data) {
  const r = data?.chart?.result?.[0];
  if (!r) return null;
  const meta = r.meta || {};
  const companyName = meta.longName || meta.shortName || meta.symbol || '';
  const ts = r.timestamp;
  const q = r.indicators?.quote?.[0];
  if (!ts?.length || !q) return null;
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({ t: ts[i], o, h, l, c, v: q.volume?.[i] ?? 0 });
  }
  return candles.length ? { candles, companyName } : null;
}

async function fetchYahooChart(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  return res.json();
}

async function getCandles(symbol, interval, range) {
  // Try cache first
  let json = readCachedChartJson(symbol, interval, range, 0); // 0 = ignore age
  if (!json) {
    console.log(`  Cache miss for ${symbol}, fetching from Yahoo...`);
    json = await fetchYahooChart(symbol, interval, range);
    writeCachedChartJson(symbol, interval, range, json);
  }
  const parsed = parseChartJson(json);
  if (!parsed?.candles?.length) return null;
  return trimTrailingFlatCandles(parsed.candles);
}

/** Filter candles to only include last Friday's trading session */
function filterLastFriday(candles) {
  if (!candles?.length) return [];

  // Find the last Friday in the data
  const dates = candles.map(c => {
    const d = new Date(c.t * 1000);
    return { date: d.toISOString().slice(0, 10), day: d.getDay(), candle: c };
  });

  // Find unique dates that are Friday (day=5)
  const fridays = [...new Set(dates.filter(d => d.day === 5).map(d => d.date))];
  if (!fridays.length) {
    // Fallback: use last trading day
    const lastDate = dates[dates.length - 1].date;
    return candles.filter(c => new Date(c.t * 1000).toISOString().slice(0, 10) === lastDate);
  }

  const lastFriday = fridays[fridays.length - 1];
  return candles.filter(c => new Date(c.t * 1000).toISOString().slice(0, 10) === lastFriday);
}

function formatTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

async function main() {
  const { timeframe, indexName } = parseArgs();
  const tf = TIMEFRAME_MAP[timeframe];
  if (!tf) { console.error(`Unknown timeframe: ${timeframe}`); process.exit(1); }

  console.log(`\n=== CandleScan v2 Simulation ===`);
  console.log(`Index: ${indexName} | Timeframe: ${timeframe}`);
  console.log(`Capital: Rs.${CAPITAL.toLocaleString()} | Max positions: ${MAX_POSITIONS} | Per trade: Rs.${POSITION_SIZE.toLocaleString()}`);
  console.log(`Min confidence: ${MIN_CONFIDENCE} | Skip first ${SKIP_FIRST_BARS} bars | Min avg volume: ${MIN_AVG_VOLUME.toLocaleString()}`);
  console.log('');

  // 1. Fetch index constituents
  console.log('Fetching index constituents...');
  const symbols = await fetchNseIndexSymbolsNode(indexName);
  console.log(`Got ${symbols.length} symbols\n`);

  // 2. Load all candle data
  console.log('Loading candle data (cache + Yahoo)...');
  const stockData = {};
  let loaded = 0;
  for (const sym of symbols) {
    const yahooSym = `${sym}.NS`;
    try {
      const allCandles = await getCandles(yahooSym, tf.interval, tf.range);
      if (!allCandles?.length) continue;
      const fridayCandles = filterLastFriday(allCandles);
      if (fridayCandles.length < 10) continue;

      // Check avg volume
      const avgVol = fridayCandles.reduce((s, c) => s + c.v, 0) / fridayCandles.length;
      if (avgVol < MIN_AVG_VOLUME) continue;

      // We also need prior candles for pattern lookback
      // Find where Friday starts in allCandles
      const fridayStart = allCandles.indexOf(fridayCandles[0]);
      const priorCandles = allCandles.slice(Math.max(0, fridayStart - 20), fridayStart);

      stockData[sym] = { fridayCandles, priorCandles, avgVol };
      loaded++;
    } catch (e) {
      // Skip on error
    }
    // Throttle
    if (loaded % 10 === 0) await new Promise(r => setTimeout(r, 200));
  }
  console.log(`Loaded ${loaded} stocks with valid Friday data\n`);

  if (!loaded) {
    console.log('No data available. Try warming the cache: npm run cache:charts');
    process.exit(0);
  }

  // Get Friday date from first stock
  const firstStock = Object.values(stockData)[0];
  const fridayDate = new Date(firstStock.fridayCandles[0].t * 1000).toISOString().slice(0, 10);
  console.log(`Simulation date: ${fridayDate}`);
  console.log('─'.repeat(100));

  // 3. Bar-by-bar simulation
  const trades = [];
  const openPositions = []; // { sym, direction, entry, sl, target, entryBar, shares }
  let capital = CAPITAL;
  let peakCapital = CAPITAL;
  let maxDrawdown = 0;

  // Find max bars across all stocks
  const maxBars = Math.max(...Object.values(stockData).map(d => d.fridayCandles.length));

  for (let barIdx = 0; barIdx < maxBars; barIdx++) {
    // --- Check existing positions for SL/target hit ---
    for (let p = openPositions.length - 1; p >= 0; p--) {
      const pos = openPositions[p];
      const sd = stockData[pos.sym];
      if (barIdx >= sd.fridayCandles.length) continue;
      const bar = sd.fridayCandles[barIdx];

      let exitPrice = null;
      let exitReason = null;

      if (pos.direction === 'long') {
        if (bar.l <= pos.sl) { exitPrice = pos.sl; exitReason = 'SL'; }
        else if (bar.h >= pos.target) { exitPrice = pos.target; exitReason = 'TARGET'; }
      } else {
        if (bar.h >= pos.sl) { exitPrice = pos.sl; exitReason = 'SL'; }
        else if (bar.l <= pos.target) { exitPrice = pos.target; exitReason = 'TARGET'; }
      }

      // EOD exit on last bar
      if (!exitPrice && barIdx === sd.fridayCandles.length - 1) {
        exitPrice = bar.c;
        exitReason = 'EOD';
      }

      if (exitPrice) {
        const grossPnl = pos.direction === 'long'
          ? (exitPrice - pos.entry) * pos.shares
          : (pos.entry - exitPrice) * pos.shares;
        const txCost = (pos.entry * pos.shares + exitPrice * pos.shares) * TX_COST_PCT;
        const netPnl = grossPnl - txCost;

        capital += netPnl;
        peakCapital = Math.max(peakCapital, capital);
        maxDrawdown = Math.max(maxDrawdown, peakCapital - capital);

        trades.push({
          sym: pos.sym,
          direction: pos.direction,
          entry: pos.entry,
          exit: exitPrice,
          shares: pos.shares,
          grossPnl,
          txCost,
          netPnl,
          reason: exitReason,
          entryTime: formatTime(sd.fridayCandles[pos.entryBar].t),
          exitTime: formatTime(bar.t),
          confidence: pos.confidence,
          action: pos.action,
          pattern: pos.pattern,
        });

        openPositions.splice(p, 1);
      }
    }

    // --- Generate new signals (skip first N bars) ---
    if (barIdx < SKIP_FIRST_BARS) continue;
    if (openPositions.length >= MAX_POSITIONS) continue;

    for (const sym of Object.keys(stockData)) {
      if (openPositions.length >= MAX_POSITIONS) break;
      if (openPositions.some(p => p.sym === sym)) continue; // already in this stock

      const sd = stockData[sym];
      if (barIdx >= sd.fridayCandles.length) continue;

      // Build candle array: prior context + Friday candles up to current bar (NO LOOKAHEAD)
      const candlesSoFar = [...sd.priorCandles, ...sd.fridayCandles.slice(0, barIdx + 1)];
      if (candlesSoFar.length < 10) continue;

      // Run v2 engine
      const patterns = detectPatterns(candlesSoFar, { barIndex: barIdx });
      const box = detectLiquidityBox(candlesSoFar);
      const risk = computeRiskScore({ candles: candlesSoFar, patterns, box, opts: { barIndex: barIdx } });

      if (risk.confidence < MIN_CONFIDENCE) continue;
      if (!ACTIONABLE.has(risk.action)) continue;

      // Calculate position
      const shares = Math.floor(POSITION_SIZE / risk.entry);
      if (shares < 1) continue;

      openPositions.push({
        sym,
        direction: risk.direction,
        entry: risk.entry,
        sl: risk.sl,
        target: risk.target,
        entryBar: barIdx,
        shares,
        confidence: risk.confidence,
        action: risk.action,
        pattern: patterns[0]?.name || 'None',
      });
    }
  }

  // 4. Print results
  console.log('\n=== TRADE LOG ===\n');
  console.log(
    'Symbol'.padEnd(14) +
    'Dir'.padEnd(7) +
    'Entry'.padEnd(10) +
    'Exit'.padEnd(10) +
    'Shares'.padEnd(8) +
    'P&L'.padEnd(12) +
    'Reason'.padEnd(8) +
    'Time'.padEnd(16) +
    'Conf'.padEnd(6) +
    'Pattern'
  );
  console.log('─'.repeat(100));

  for (const t of trades) {
    const pnlStr = (t.netPnl >= 0 ? '+' : '') + t.netPnl.toFixed(0);
    console.log(
      t.sym.padEnd(14) +
      t.direction.padEnd(7) +
      t.entry.toFixed(2).padEnd(10) +
      t.exit.toFixed(2).padEnd(10) +
      String(t.shares).padEnd(8) +
      pnlStr.padEnd(12) +
      t.reason.padEnd(8) +
      `${t.entryTime}-${t.exitTime}`.padEnd(16) +
      String(t.confidence).padEnd(6) +
      t.pattern
    );
  }

  // 5. Summary
  const wins = trades.filter(t => t.netPnl > 0).length;
  const losses = trades.filter(t => t.netPnl <= 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const totalTxCost = trades.reduce((s, t) => s + t.txCost, 0);
  const winRate = trades.length ? (wins / trades.length * 100).toFixed(1) : '0.0';

  console.log('\n' + '═'.repeat(100));
  console.log('=== SIMULATION SUMMARY ===\n');
  console.log(`Date:            ${fridayDate}`);
  console.log(`Stocks scanned:  ${loaded}`);
  console.log(`Total trades:    ${trades.length}`);
  console.log(`Wins / Losses:   ${wins} / ${losses} (${winRate}% win rate)`);
  console.log(`Total P&L:       Rs.${totalPnl.toFixed(0)} (${(totalPnl / CAPITAL * 100).toFixed(2)}%)`);
  console.log(`Transaction cost: Rs.${totalTxCost.toFixed(0)}`);
  console.log(`Starting capital: Rs.${CAPITAL.toLocaleString()}`);
  console.log(`Final capital:   Rs.${capital.toFixed(0)}`);
  console.log(`Max drawdown:    Rs.${maxDrawdown.toFixed(0)} (${(maxDrawdown / CAPITAL * 100).toFixed(2)}%)`);
  console.log(`Return:          ${((capital - CAPITAL) / CAPITAL * 100).toFixed(2)}%`);
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
