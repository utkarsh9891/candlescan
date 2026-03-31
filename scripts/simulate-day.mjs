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

import { detectPatterns as detectPatternsV2 } from '../src/engine/patterns-v2.js';
import { detectLiquidityBox as detectLiquidityBoxV2 } from '../src/engine/liquidityBox-v2.js';
import { computeRiskScore as computeRiskScoreV2 } from '../src/engine/risk-v2.js';
import { detectPatterns as detectPatternsScalp } from '../src/engine/patterns-scalp.js';
import { detectLiquidityBox as detectLiquidityBoxScalp } from '../src/engine/liquidityBox-scalp.js';
import { computeRiskScore as computeRiskScoreScalp } from '../src/engine/risk-scalp.js';
import { trimTrailingFlatCandles } from '../src/engine/fetcher.js';
import { fetchNseIndexSymbolsNode } from './lib/nse-http.mjs';
import { readCachedChartJson, writeCachedChartJson } from './lib/chart-cache-fs.mjs';
import { DEFAULT_NSE_INDEX_ID } from '../src/config/nseIndices.js';

const TIMEFRAME_MAP = {
  '1m': { interval: '1m', range: '5d' },
  '5m': { interval: '5m', range: '5d' },
  '15m': { interval: '15m', range: '5d' },
};

const TX_COST_PCT = 0.0005; // 0.05% per side
const ACTIONABLE = new Set(['STRONG BUY', 'BUY', 'STRONG SHORT', 'SHORT']);

function parseArgs() {
  const args = process.argv.slice(2);
  let timeframe = '1m';
  let indexName = 'NIFTY 200';
  let date = null;
  let engine = 'scalp';
  let minConfidence = 80;
  let maxPositions = 1;
  let maxTotalTrades = 10;
  let positionSize = 300000;
  let skipFirstBars = 0;
  let fromTime = '09:30';
  let toTime = '11:00';
  let multiWindow = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--index' && args[i + 1]) { indexName = args[++i]; continue; }
    if (args[i] === '--date' && args[i + 1]) { date = args[++i]; continue; }
    if (args[i] === '--engine' && args[i + 1]) { engine = args[++i]; continue; }
    if (args[i] === '--confidence' && args[i + 1]) { minConfidence = +args[++i]; continue; }
    if (args[i] === '--max-positions' && args[i + 1]) { maxPositions = +args[++i]; continue; }
    if (args[i] === '--max-trades' && args[i + 1]) { maxTotalTrades = +args[++i]; continue; }
    if (args[i] === '--position-size' && args[i + 1]) { positionSize = +args[++i]; continue; }
    if (args[i] === '--skip-bars' && args[i + 1]) { skipFirstBars = +args[++i]; continue; }
    if (args[i] === '--from' && args[i + 1]) { fromTime = args[++i]; continue; }
    if (args[i] === '--to' && args[i + 1]) { toTime = args[++i]; continue; }
    if (args[i] === '--multi-window') { multiWindow = true; continue; }
    if (TIMEFRAME_MAP[args[i]]) timeframe = args[i];
  }
  const capital = positionSize * maxPositions;
  return { timeframe, indexName, date, engine, minConfidence, maxPositions, maxTotalTrades, positionSize, skipFirstBars, capital, fromTime, toTime, multiWindow };
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

function istTimeStr(t) {
  const d = new Date((t + IST_OFFSET) * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function formatTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Filter candles to a time window (HH:MM - HH:MM) */
function filterByTimeWindow(candles, startTime = '09:30', endTime = '11:00') {
  return candles.filter(c => {
    const t = istTimeStr(c.t);
    return t >= startTime && t <= endTime;
  });
}

/** Run a single-window bar-by-bar simulation and return results. */
function runWindow(stockDataForWindow, { detectPatterns, detectLiquidityBox, computeRiskScore, MIN_CONFIDENCE, MAX_POSITIONS, POSITION_SIZE, CAPITAL, SKIP_FIRST_BARS, MAX_TOTAL_TRADES, indexDirection }) {
  const trades = [];
  const openPositions = [];
  const cooldownUntil = {}; // sym -> barIdx when cooldown expires (prevent whipsaw)
  let currentCapital = CAPITAL;
  let peakCapital = CAPITAL;
  let maxDrawdown = 0;
  let totalTradesOpened = 0;

  const maxBars = Math.max(...Object.values(stockDataForWindow).map(d => d.windowCandles.length));

  for (let barIdx = 0; barIdx < maxBars; barIdx++) {
    // --- Check existing positions for SL/target hit (hard SL, no trailing) ---
    for (let p = openPositions.length - 1; p >= 0; p--) {
      const pos = openPositions[p];
      const sd = stockDataForWindow[pos.sym];
      if (barIdx >= sd.windowCandles.length) continue;
      const bar = sd.windowCandles[barIdx];

      let exitPrice = null;
      let exitReason = null;

      if (pos.direction === 'long') {
        if (bar.l <= pos.sl) { exitPrice = pos.sl; exitReason = 'SL'; }
        else if (bar.h >= pos.target) { exitPrice = pos.target; exitReason = 'TARGET'; }
      } else {
        if (bar.h >= pos.sl) { exitPrice = pos.sl; exitReason = 'SL'; }
        else if (bar.l <= pos.target) { exitPrice = pos.target; exitReason = 'TARGET'; }
      }

      if (!exitPrice && pos.maxHoldBars && (barIdx - pos.entryBar) >= pos.maxHoldBars) {
        exitPrice = bar.c;
        exitReason = 'TIME';
      }

      if (!exitPrice && barIdx === sd.windowCandles.length - 1) {
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
          sym: pos.sym, direction: pos.direction,
          entry: pos.entry, exit: exitPrice, shares: pos.shares,
          grossPnl, txCost, netPnl, reason: exitReason,
          entryTime: formatTime(sd.windowCandles[pos.entryBar].t),
          exitTime: formatTime(bar.t),
          confidence: pos.confidence, action: pos.action, pattern: pos.pattern,
        });

        openPositions.splice(p, 1);
        // Set cooldown: don't re-enter same stock for 2 bars
        cooldownUntil[pos.sym] = barIdx + 2;
      }
    }

    if (barIdx < SKIP_FIRST_BARS) continue;
    if (openPositions.length >= MAX_POSITIONS) continue;
    if (totalTradesOpened >= MAX_TOTAL_TRADES) continue;

    for (const sym of Object.keys(stockDataForWindow)) {
      if (openPositions.length >= MAX_POSITIONS) break;
      if (totalTradesOpened >= MAX_TOTAL_TRADES) break;
      if (openPositions.some(p => p.sym === sym)) continue;
      if (cooldownUntil[sym] && barIdx < cooldownUntil[sym]) continue;

      const sd = stockDataForWindow[sym];
      if (barIdx >= sd.windowCandles.length) continue;

      const dayBarIdx = sd.firstWindowIdx + barIdx;
      const preWindow = sd.preWindowCandles || [];
      const candlesSoFar = [...sd.priorCandles, ...preWindow, ...sd.dayCandles.slice(0, dayBarIdx + 1)];
      if (candlesSoFar.length < 10) continue;

      const patterns = detectPatterns(candlesSoFar, {
        barIndex: barIdx,
        orbHigh: sd.orbHigh,
        orbLow: sd.orbLow,
        prevDayHigh: sd.prevDayHigh,
        prevDayLow: sd.prevDayLow,
      });
      const box = detectLiquidityBox(candlesSoFar);
      const risk = computeRiskScore({ candles: candlesSoFar, patterns, box, opts: { barIndex: barIdx, indexDirection } });

      if (risk.confidence < MIN_CONFIDENCE) continue;
      if (!ACTIONABLE.has(risk.action)) continue;

      const shares = Math.floor(POSITION_SIZE / risk.entry);
      if (shares < 1) continue;

      openPositions.push({
        sym, direction: risk.direction,
        entry: risk.entry, sl: risk.sl, target: risk.target,
        entryBar: barIdx, shares,
        confidence: risk.confidence, action: risk.action,
        pattern: patterns[0]?.name || 'None',
        maxHoldBars: risk.maxHoldBars || null,
      });
      totalTradesOpened++;
    }
  }

  return { trades, currentCapital, peakCapital, maxDrawdown };
}

function printTrades(trades) {
  console.log(
    'Symbol'.padEnd(14) + 'Dir'.padEnd(7) + 'Entry'.padEnd(10) + 'Exit'.padEnd(10) +
    'Shares'.padEnd(8) + 'P&L'.padEnd(12) + 'Reason'.padEnd(8) + 'Time'.padEnd(16) +
    'Conf'.padEnd(6) + 'Pattern'
  );
  console.log('─'.repeat(100));
  for (const t of trades) {
    const pnlStr = (t.netPnl >= 0 ? '+' : '') + t.netPnl.toFixed(0);
    console.log(
      t.sym.padEnd(14) + t.direction.padEnd(7) + t.entry.toFixed(2).padEnd(10) +
      t.exit.toFixed(2).padEnd(10) + String(t.shares).padEnd(8) + pnlStr.padEnd(12) +
      t.reason.padEnd(8) + `${t.entryTime}-${t.exitTime}`.padEnd(16) +
      String(t.confidence).padEnd(6) + t.pattern
    );
  }
}

function printSummary(trades, capital, currentCapital, maxDrawdown, label = 'SIMULATION SUMMARY') {
  const wins = trades.filter(t => t.netPnl > 0).length;
  const losses = trades.filter(t => t.netPnl <= 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const totalTxCost = trades.reduce((s, t) => s + t.txCost, 0);
  const winRate = trades.length ? (wins / trades.length * 100).toFixed(1) : '0.0';

  console.log(`\n=== ${label} ===\n`);
  console.log(`Total trades:    ${trades.length}`);
  console.log(`Wins / Losses:   ${wins} / ${losses} (${winRate}% win rate)`);
  console.log(`Total P&L:       Rs.${totalPnl.toFixed(0)} (${(totalPnl / capital * 100).toFixed(2)}%)`);
  console.log(`Transaction cost: Rs.${totalTxCost.toFixed(0)}`);
  console.log(`Starting capital: Rs.${capital.toLocaleString()}`);
  console.log(`Final capital:   Rs.${currentCapital.toFixed(0)}`);
  console.log(`Max drawdown:    Rs.${maxDrawdown.toFixed(0)} (${(maxDrawdown / capital * 100).toFixed(2)}%)`);
  console.log(`Return:          ${((currentCapital - capital) / capital * 100).toFixed(2)}%`);
}

/** Build window-specific stock data by re-filtering dayCandles for a time window.
 *  Volume threshold is auto-detected: 25th percentile of all stocks' avg volume. */
function buildWindowStockData(allStockBase, wFrom, wTo) {
  // First pass: compute avgVol for ALL stocks, collect pre-window candles
  const candidates = [];
  for (const [sym, base] of Object.entries(allStockBase)) {
    const windowCandles = filterByTimeWindow(base.dayCandles, wFrom, wTo);
    if (windowCandles.length < 3) continue;
    const avgVol = windowCandles.reduce((s, c) => s + c.v, 0) / windowCandles.length;
    const firstWindowIdx = base.dayCandles.indexOf(windowCandles[0]);
    // Pre-window candles: 09:15 to window start for pattern lookback context
    const preWindowCandles = base.dayCandles.filter(c => {
      const t = istTimeStr(c.t);
      return t >= '09:15' && t < wFrom;
    });
    candidates.push({ sym, base, windowCandles, firstWindowIdx, avgVol, preWindowCandles });
  }

  const noWindowData = Object.keys(allStockBase).length - candidates.length;
  if (!candidates.length) {
    console.log(`  ${Object.keys(allStockBase).length} stocks loaded`);
    console.log(`  ${noWindowData} filtered: no data in ${wFrom}-${wTo} window`);
    console.log(`  0 passed → ready for simulation`);
    return {};
  }

  // Auto-detect volume threshold: 25th percentile
  const sortedVols = candidates.map(c => c.avgVol).sort((a, b) => a - b);
  const p25Idx = Math.floor(sortedVols.length * 0.25);
  const volThreshold = sortedVols[p25Idx] || 0;

  // Second pass: filter by volume
  const result = {};
  let volFiltered = 0;
  for (const c of candidates) {
    if (c.avgVol < volThreshold) { volFiltered++; continue; }
    result[c.sym] = { ...c.base, windowCandles: c.windowCandles, firstWindowIdx: c.firstWindowIdx, avgVol: c.avgVol, preWindowCandles: c.preWindowCandles };
  }

  const passed = Object.keys(result).length;
  console.log(`  ${noWindowData} filtered: no data in ${wFrom}-${wTo} window`);
  console.log(`  ${volFiltered} filtered: avg volume below ${Math.round(volThreshold).toLocaleString()} (25th pctile)`);
  console.log(`  ${passed} passed → ready for simulation`);

  return result;
}

async function main() {
  const { timeframe, indexName, date: targetDate, engine, minConfidence, maxPositions, maxTotalTrades, positionSize, skipFirstBars, capital, fromTime, toTime, multiWindow } = parseArgs();

  const detectPatterns = engine === 'scalp' ? detectPatternsScalp : detectPatternsV2;
  const detectLiquidityBox = engine === 'scalp' ? detectLiquidityBoxScalp : detectLiquidityBoxV2;
  const computeRiskScore = engine === 'scalp' ? computeRiskScoreScalp : computeRiskScoreV2;
  const CAPITAL = capital;
  const tf = TIMEFRAME_MAP[timeframe];
  if (!tf) { console.error(`Unknown timeframe: ${timeframe}`); process.exit(1); }

  console.log(`\n=== CandleScan ${engine} Simulation${multiWindow ? ' (Multi-Window)' : ''} ===`);
  console.log(`Index: ${indexName} | Timeframe: ${timeframe} | Date: ${targetDate || 'latest'} | Engine: ${engine}`);
  console.log(`Capital: Rs.${CAPITAL.toLocaleString()} | Max concurrent: ${maxPositions} | Per trade: Rs.${positionSize.toLocaleString()} | Max trades: ${maxTotalTrades}`);
  console.log(`Min confidence: ${minConfidence} | Skip first ${skipFirstBars} bars | Volume: auto (25th pctile)`);
  console.log('');

  // 1. Fetch index constituents (with cache fallback)
  console.log('Fetching index constituents...');
  let symbols;
  try {
    symbols = await fetchNseIndexSymbolsNode(indexName);
  } catch (e) {
    console.log(`NSE API failed (${e.message}), falling back to cached symbols...`);
    // Derive symbols from cached 1m files
    const fs = await import('node:fs');
    const path = await import('node:path');
    const cacheDir = path.default.resolve(new URL('.', import.meta.url).pathname, '../cache/charts');
    const files = fs.default.readdirSync(cacheDir).filter(f => f.endsWith(`_${tf.interval}_${tf.range}.json`) && !f.startsWith('^'));
    symbols = files.map(f => f.replace(`.NS_${tf.interval}_${tf.range}.json`, ''));
  }
  console.log(`Got ${symbols.length} symbols\n`);

  // 2. Load candle data (cache only) — load full day for all stocks
  console.log('Loading candle data from cache...');
  const allStockBase = {};
  let loaded = 0;
  const filterStats = { total: symbols.length, noCache: 0, noCandles: 0, noDate: 0, loaded: 0 };
  for (const sym of symbols) {
    const yahooSym = `${sym}.NS`;
    try {
      const cached = readCachedChartJson(yahooSym, tf.interval, tf.range, 0);
      if (!cached) { filterStats.noCache++; continue; }
      const parsed = parseChartJson(cached);
      if (!parsed?.candles?.length) { filterStats.noCandles++; continue; }
      const allCandles = trimTrailingFlatCandles(parsed.candles);
      if (!allCandles?.length) { filterStats.noCandles++; continue; }

      const dayCandles = filterByDate(allCandles, targetDate);
      if (dayCandles.length < 5) { filterStats.noDate++; continue; }

      const dayStart = allCandles.indexOf(dayCandles[0]);
      const priorCandles = allCandles.slice(Math.max(0, dayStart - 20), dayStart);

      const targetDateStr = istDateStr(dayCandles[0].t);
      const prevDayCandles = allCandles.filter(c => istDateStr(c.t) < targetDateStr);
      const prevDayHigh = prevDayCandles.length ? Math.max(...prevDayCandles.map(c => c.h)) : null;
      const prevDayLow = prevDayCandles.length ? Math.min(...prevDayCandles.map(c => c.l)) : null;

      const orbBars = dayCandles.slice(0, 15);
      const orbHigh = orbBars.length >= 5 ? Math.max(...orbBars.map(c => c.h)) : null;
      const orbLow = orbBars.length >= 5 ? Math.min(...orbBars.map(c => c.l)) : null;

      allStockBase[sym] = { dayCandles, priorCandles, prevDayHigh, prevDayLow, orbHigh, orbLow };
      loaded++;
    } catch (e) { /* skip */ }
  }
  filterStats.loaded = loaded;
  console.log(`\n── Stock Filter Pipeline ──`);
  console.log(`  ${filterStats.total} symbols in index`);
  console.log(`  ${filterStats.noCache} filtered: no cache data`);
  console.log(`  ${filterStats.noCandles} filtered: no valid candles`);
  console.log(`  ${filterStats.noDate} filtered: no data for target date`);
  console.log(`  ${filterStats.loaded} passed → loaded for simulation`);

  if (!loaded) {
    console.log('No data available. Try warming the cache: npm run cache:charts');
    process.exit(0);
  }

  const firstStock = Object.values(allStockBase)[0];
  const simDate = istDateStr(firstStock.dayCandles[0].t);
  console.log(`Simulation date: ${simDate}`);
  console.log('─'.repeat(100));

  // Compute index direction
  let indexDirection = { direction: 'neutral', strength: 0 };
  if (engine === 'scalp') {
    const niftySym = '^NSEI';
    const niftyJson = readCachedChartJson(niftySym, tf.interval, tf.range, 0);
    if (niftyJson) {
      const niftyParsed = parseChartJson(niftyJson);
      if (niftyParsed?.candles?.length >= 20) {
        const nc = niftyParsed.candles;
        const closes = nc.map(c => c.c);
        const sma10 = closes.slice(-10).reduce((a, b) => a + b, 0) / 10;
        const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const last5 = nc.slice(-5);
        const momentum = (last5[last5.length - 1].c - last5[0].c) / last5[0].c;
        if (sma10 > sma20 && momentum > 0) indexDirection = { direction: 'bullish', strength: Math.min(1, Math.abs(momentum) * 100) };
        else if (sma10 < sma20 && momentum < 0) indexDirection = { direction: 'bearish', strength: Math.min(1, Math.abs(momentum) * 100) };
        console.log(`Index direction: ${indexDirection.direction} (strength: ${indexDirection.strength.toFixed(2)})`);
      }
    } else {
      console.log('Warning: NIFTY cache not found — index direction filter disabled');
    }
  }

  const simParams = { detectPatterns, detectLiquidityBox, computeRiskScore, MIN_CONFIDENCE: minConfidence, MAX_POSITIONS: maxPositions, POSITION_SIZE: positionSize, CAPITAL, SKIP_FIRST_BARS: skipFirstBars, MAX_TOTAL_TRADES: maxTotalTrades, indexDirection };

  if (multiWindow) {
    // Multi-window mode: run 3 windows sequentially
    const windows = [
      { from: '09:30', to: '11:00', label: 'Window 1 (9:30-11:00)' },
      { from: '11:00', to: '13:00', label: 'Window 2 (11:00-13:00)' },
      { from: '13:00', to: '14:30', label: 'Window 3 (13:00-14:30)' },
    ];
    let aggregateTrades = [];
    let aggregateCapital = CAPITAL;
    let aggregateMaxDD = 0;

    for (const w of windows) {
      console.log(`\n${'═'.repeat(100)}`);
      console.log(`>>> ${w.label}`);
      console.log('═'.repeat(100));

      const windowData = buildWindowStockData(allStockBase, w.from, w.to);
      const stockCount = Object.keys(windowData).length;
      console.log(`Stocks with data in window: ${stockCount}`);

      if (!stockCount) {
        console.log('No stocks with data in this window.\n');
        continue;
      }

      const result = runWindow(windowData, simParams);
      printTrades(result.trades);
      printSummary(result.trades, CAPITAL, result.currentCapital, result.maxDrawdown, w.label);

      aggregateTrades = aggregateTrades.concat(result.trades);
      aggregateCapital += (result.currentCapital - CAPITAL);
      aggregateMaxDD = Math.max(aggregateMaxDD, result.maxDrawdown);
    }

    // Aggregate summary
    console.log(`\n${'═'.repeat(100)}`);
    console.log('═'.repeat(100));
    printSummary(aggregateTrades, CAPITAL, aggregateCapital, aggregateMaxDD, `AGGREGATE (All Windows) — ${simDate}`);
    console.log('');
  } else {
    // Single window mode
    const windowData = buildWindowStockData(allStockBase, fromTime, toTime);
    const stockCount = Object.keys(windowData).length;
    console.log(`Stocks with data in window: ${stockCount}`);

    if (!stockCount) {
      console.log('No stocks with data in this window.');
      process.exit(0);
    }

    const result = runWindow(windowData, simParams);

    console.log('\n=== TRADE LOG ===\n');
    printTrades(result.trades);
    printSummary(result.trades, CAPITAL, result.currentCapital, result.maxDrawdown, `SIMULATION SUMMARY — ${simDate}`);
    console.log(`Stocks scanned:  ${stockCount}`);
    console.log('');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
