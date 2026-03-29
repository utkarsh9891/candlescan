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

const TX_COST_PCT = 0.0005; // 0.05% per side
const MIN_AVG_VOLUME = 50000;
const ACTIONABLE = new Set(['STRONG BUY', 'BUY', 'STRONG SHORT', 'SHORT']);

function parseArgs() {
  const args = process.argv.slice(2);
  let timeframe = '5m';
  let indexName = 'NIFTY 50';
  let date = null;
  let minConfidence = 80;
  let maxPositions = 3;
  let maxTotalTrades = 6;
  let positionSize = 100000;
  let skipFirstBars = 4;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--index' && args[i + 1]) { indexName = args[++i]; continue; }
    if (args[i] === '--date' && args[i + 1]) { date = args[++i]; continue; }
    if (args[i] === '--confidence' && args[i + 1]) { minConfidence = +args[++i]; continue; }
    if (args[i] === '--max-positions' && args[i + 1]) { maxPositions = +args[++i]; continue; }
    if (args[i] === '--max-trades' && args[i + 1]) { maxTotalTrades = +args[++i]; continue; }
    if (args[i] === '--position-size' && args[i + 1]) { positionSize = +args[++i]; continue; }
    if (args[i] === '--skip-bars' && args[i + 1]) { skipFirstBars = +args[++i]; continue; }
    if (TIMEFRAME_MAP[args[i]]) timeframe = args[i];
  }
  const capital = positionSize * maxPositions;
  return { timeframe, indexName, date, minConfidence, maxPositions, maxTotalTrades, positionSize, skipFirstBars, capital };
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

const IST_OFFSET = 19800; // +5:30 in seconds

function istDateStr(t) {
  return new Date((t + IST_OFFSET) * 1000).toISOString().slice(0, 10);
}

/** Filter candles to a specific date, or last trading day if not specified */
function filterByDate(candles, targetDate) {
  if (!candles?.length) return [];
  if (targetDate) {
    return candles.filter(c => istDateStr(c.t) === targetDate);
  }
  // Fallback: last available date
  const lastDate = istDateStr(candles[candles.length - 1].t);
  return candles.filter(c => istDateStr(c.t) === lastDate);
}

function formatTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

async function main() {
  const { timeframe, indexName, date: targetDate, minConfidence, maxPositions, maxTotalTrades, positionSize, skipFirstBars, capital } = parseArgs();
  const MIN_CONFIDENCE = minConfidence;
  const MAX_POSITIONS = maxPositions;
  const POSITION_SIZE = positionSize;
  const CAPITAL = capital;
  const SKIP_FIRST_BARS = skipFirstBars;
  const MAX_TOTAL_TRADES = maxTotalTrades;
  const tf = TIMEFRAME_MAP[timeframe];
  if (!tf) { console.error(`Unknown timeframe: ${timeframe}`); process.exit(1); }

  console.log(`\n=== CandleScan v2 Simulation ===`);
  console.log(`Index: ${indexName} | Timeframe: ${timeframe} | Date: ${targetDate || 'latest'}`);
  console.log(`Capital: Rs.${CAPITAL.toLocaleString()} | Max concurrent: ${MAX_POSITIONS} | Per trade: Rs.${POSITION_SIZE.toLocaleString()} | Max trades: ${MAX_TOTAL_TRADES}`);
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
      const dayCandles = filterByDate(allCandles, targetDate);
      if (dayCandles.length < 10) continue;

      // Check avg volume
      const avgVol = dayCandles.reduce((s, c) => s + c.v, 0) / dayCandles.length;
      if (avgVol < MIN_AVG_VOLUME) continue;

      // We also need prior candles for pattern lookback
      // Find where Friday starts in allCandles
      const fridayStart = allCandles.indexOf(dayCandles[0]);
      const priorCandles = allCandles.slice(Math.max(0, fridayStart - 20), fridayStart);

      stockData[sym] = { dayCandles, priorCandles, avgVol };
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
  const simDate = istDateStr(firstStock.dayCandles[0].t);
  console.log(`Simulation date: ${simDate}`);
  console.log('─'.repeat(100));

  // 3. Bar-by-bar simulation
  const trades = [];
  const openPositions = []; // { sym, direction, entry, sl, target, entryBar, shares }
  let currentCapital = CAPITAL;
  let peakCapital = CAPITAL;
  let maxDrawdown = 0;
  let totalTradesOpened = 0;

  // Find max bars across all stocks
  const maxBars = Math.max(...Object.values(stockData).map(d => d.dayCandles.length));

  for (let barIdx = 0; barIdx < maxBars; barIdx++) {
    // --- Check existing positions for SL/target hit ---
    for (let p = openPositions.length - 1; p >= 0; p--) {
      const pos = openPositions[p];
      const sd = stockData[pos.sym];
      if (barIdx >= sd.dayCandles.length) continue;
      const bar = sd.dayCandles[barIdx];

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
      if (!exitPrice && barIdx === sd.dayCandles.length - 1) {
        exitPrice = bar.c;
        exitReason = 'EOD';
      }

      if (exitPrice) {
        const grossPnl = pos.direction === 'long'
          ? (exitPrice - pos.entry) * pos.shares
          : (pos.entry - exitPrice) * pos.shares;
        const txCost = (pos.entry * pos.shares + exitPrice * pos.shares) * TX_COST_PCT;
        const netPnl = grossPnl - txCost;

        currentCapital += netPnl;
        peakCapital = Math.max(peakCapital, currentCapital);
        maxDrawdown = Math.max(maxDrawdown, peakCapital - currentCapital);

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
          entryTime: formatTime(sd.dayCandles[pos.entryBar].t),
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
    if (totalTradesOpened >= MAX_TOTAL_TRADES) continue;

    for (const sym of Object.keys(stockData)) {
      if (openPositions.length >= MAX_POSITIONS) break;
      if (totalTradesOpened >= MAX_TOTAL_TRADES) break;
      if (openPositions.some(p => p.sym === sym)) continue; // already in this stock

      const sd = stockData[sym];
      if (barIdx >= sd.dayCandles.length) continue;

      // Build candle array: prior context + Friday candles up to current bar (NO LOOKAHEAD)
      const candlesSoFar = [...sd.priorCandles, ...sd.dayCandles.slice(0, barIdx + 1)];
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
      totalTradesOpened++;
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
  console.log(`Date:            ${simDate}`);
  console.log(`Stocks scanned:  ${loaded}`);
  console.log(`Total trades:    ${trades.length}`);
  console.log(`Wins / Losses:   ${wins} / ${losses} (${winRate}% win rate)`);
  console.log(`Total P&L:       Rs.${totalPnl.toFixed(0)} (${(totalPnl / CAPITAL * 100).toFixed(2)}%)`);
  console.log(`Transaction cost: Rs.${totalTxCost.toFixed(0)}`);
  console.log(`Starting capital: Rs.${CAPITAL.toLocaleString()}`);
  console.log(`Final capital:   Rs.${currentCapital.toFixed(0)}`);
  console.log(`Max drawdown:    Rs.${maxDrawdown.toFixed(0)} (${(maxDrawdown / CAPITAL * 100).toFixed(2)}%)`);
  console.log(`Return:          ${((currentCapital - CAPITAL) / CAPITAL * 100).toFixed(2)}%`);
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
