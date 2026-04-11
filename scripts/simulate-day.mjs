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
import { getScalpVariantFns } from '../src/engine/scalp-variants/registry.js';
import { trimTrailingFlatCandles } from '../src/engine/fetcher.js';
import { fetchNseIndexSymbolsNode } from './lib/nse-http.mjs';
import { readCachedChartJson, writeCachedChartJson, listCachedDates, listCachedSymbols } from './lib/chart-cache-fs.mjs';
import { DEFAULT_NSE_INDEX_ID } from '../src/config/nseIndices.js';
import { fetchMarginMapNode, MARGIN_MULTIPLIER } from '../src/data/marginData.js';
import { SECTOR_INDEX_SYMBOLS, getSector } from '../src/engine/sectorMap.js';

const TIMEFRAME_MAP = {
  '1m': { interval: '1m' },
  '5m': { interval: '5m' },
  '15m': { interval: '15m' },
};

// Premium-broker round-trip cost: ~0.04% (Rs 600 per trade on 15L leveraged).
// 0.02% per side × 2 sides ≈ Rs 600 all-in on a Rs 15L position (matches
// Zerodha Pro / Dhan Premium MIS on large/mid caps: flat ~Rs 20 +
// STT + exchange + GST). Standard retail plans are ~0.05% per side;
// configure differently if needed.
const TX_COST_PCT = 0.0002;
const ACTIONABLE = new Set(['STRONG BUY', 'BUY', 'STRONG SHORT', 'SHORT']);

function parseArgs() {
  const args = process.argv.slice(2);
  let timeframe = '1m';
  let indexName = 'NIFTY 200';
  let date = null;
  let engine = 'scalp';
  let variant = 'momentum';
  let minConfidence = 80;
  let maxPositions = 1;
  let maxTotalTrades = 10;
  let positionSize = 300000;
  let skipFirstBars = 0;
  let fromTime = '09:30';
  let toTime = '11:00';
  let multiWindow = false;
  let margin = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--index' && args[i + 1]) { indexName = args[++i]; continue; }
    if (args[i] === '--date' && args[i + 1]) { date = args[++i]; continue; }
    if (args[i] === '--engine' && args[i + 1]) { engine = args[++i]; continue; }
    if (args[i] === '--variant' && args[i + 1]) { variant = args[++i]; continue; }
    if (args[i] === '--confidence' && args[i + 1]) { minConfidence = +args[++i]; continue; }
    if (args[i] === '--max-positions' && args[i + 1]) { maxPositions = +args[++i]; continue; }
    if (args[i] === '--max-trades' && args[i + 1]) { maxTotalTrades = +args[++i]; continue; }
    if (args[i] === '--position-size' && args[i + 1]) { positionSize = +args[++i]; continue; }
    if (args[i] === '--skip-bars' && args[i + 1]) { skipFirstBars = +args[++i]; continue; }
    if (args[i] === '--from' && args[i + 1]) { fromTime = args[++i]; continue; }
    if (args[i] === '--to' && args[i + 1]) { toTime = args[++i]; continue; }
    if (args[i] === '--multi-window') { multiWindow = true; continue; }
    if (args[i] === '--no-margin') { margin = false; continue; }
    if (args[i] === '--margin') { margin = true; continue; }
    if (TIMEFRAME_MAP[args[i]]) timeframe = args[i];
  }
  const capital = positionSize * maxPositions;
  return { timeframe, indexName, date, engine, variant, minConfidence, maxPositions, maxTotalTrades, positionSize, skipFirstBars, capital, fromTime, toTime, multiWindow, margin };
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

/**
 * Fetch Yahoo chart for a specific date using period1/period2.
 * @param {string} symbol Yahoo symbol
 * @param {string} interval e.g. '1m'
 * @param {string} date YYYY-MM-DD
 */
async function fetchYahooChartForDate(symbol, interval, date) {
  const [y, m, d] = date.split('-').map(Number);
  // IST trading day: 09:15 IST = 03:45 UTC, 15:30 IST = 10:00 UTC
  const dayStart = new Date(Date.UTC(y, m - 1, d, 3, 45, 0));
  const dayEnd = new Date(Date.UTC(y, m - 1, d, 10, 0, 0));
  const p1 = Math.floor(dayStart.getTime() / 1000);
  const p2 = Math.floor(dayEnd.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&period1=${p1}&period2=${p2}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  return res.json();
}

/**
 * Get candles for a specific date from cache, falling back to Yahoo.
 * @param {string} symbol Yahoo symbol
 * @param {string} interval e.g. '1m'
 * @param {string} date YYYY-MM-DD
 */
async function getCandles(symbol, interval, date) {
  let json = readCachedChartJson(symbol, interval, date);
  if (!json) {
    console.log(`  Cache miss for ${symbol} ${date}, fetching from Yahoo...`);
    json = await fetchYahooChartForDate(symbol, interval, date);
    writeCachedChartJson(symbol, interval, date, json);
  }
  const parsed = parseChartJson(json);
  if (!parsed?.candles?.length) return null;
  return trimTrailingFlatCandles(parsed.candles);
}

/**
 * Get the previous trading date before a given date (skips weekends).
 * @param {string} date YYYY-MM-DD
 * @returns {string} YYYY-MM-DD
 */
function getPrevTradingDate(date) {
  const d = new Date(date + 'T12:00:00Z');
  d.setDate(d.getDate() - 1);
  // Skip weekends
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Get the latest available date in cache for a symbol+interval.
 * Used when --date is not specified.
 */
function getLatestCachedDate(symbol, interval) {
  const dates = listCachedDates(symbol, interval);
  return dates.length ? dates[dates.length - 1] : null;
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
function runWindow(stockDataForWindow, { detectPatterns, detectLiquidityBox, computeRiskScore, MIN_CONFIDENCE, MAX_POSITIONS, POSITION_SIZE, CAPITAL, SKIP_FIRST_BARS, MAX_TOTAL_TRADES, indexDirection, marginEnabled, marginMap, sectorData }) {
  const trades = [];
  const openPositions = [];
  const tradedSymbols = new Set();
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
        tradedSymbols.add(pos.sym);
      }
    }

    if (barIdx < SKIP_FIRST_BARS) continue;
    if (openPositions.length >= MAX_POSITIONS) continue;
    if (totalTradesOpened >= MAX_TOTAL_TRADES) continue;

    // Collect all qualifying signals at this bar, then pick best by confidence
    const candidates = [];
    for (const sym of Object.keys(stockDataForWindow)) {
      if (openPositions.some(p => p.sym === sym)) continue;
      if (tradedSymbols.has(sym)) continue; // already traded today — blacklisted

      const sd = stockDataForWindow[sym];
      if (barIdx >= sd.windowCandles.length) continue;

      const dayBarIdx = sd.firstWindowIdx + barIdx;
      const preWindow = sd.preWindowCandles || [];
      const candlesSoFar = [...sd.priorCandles, ...preWindow, ...sd.dayCandles.slice(0, dayBarIdx + 1)];
      if (candlesSoFar.length < 10) continue;

      // Compute index intraday % AT this bar's timestamp (no lookahead)
      // — the NIFTY bar closest to but not later than cur.t.
      const curTs = candlesSoFar[candlesSoFar.length - 1].t;
      let indexAtBar = indexDirection;
      if (indexDirection?.candles?.length && indexDirection.dayOpen) {
        // Find the latest NIFTY bar at or before cur.t
        let niftyCur = null;
        for (let k = indexDirection.candles.length - 1; k >= 0; k--) {
          if (indexDirection.candles[k].t <= curTs) { niftyCur = indexDirection.candles[k]; break; }
        }
        const niftyIntraPct = niftyCur ? (niftyCur.c - indexDirection.dayOpen) / indexDirection.dayOpen : 0;
        indexAtBar = { ...indexDirection, intradayPct: niftyIntraPct };
      }

      // Today's session open = the first candle of the day, 9:15 IST.
      const stockDayOpen = sd.dayCandles[0]?.o || null;

      // ── Sector strength at this bar (no lookahead) ──
      // Look up the stock's sector, find the sector index bar at or
      // before the current stock bar's timestamp, compute the sector's
      // intraday % move from its session open. Passed to the pattern
      // engine which uses it to filter sector-aligned trades only.
      const sectorKey = getSector(sym);
      let sectorAtBar = null;
      if (sectorKey && sectorData && sectorData[sectorKey]) {
        const sd2 = sectorData[sectorKey];
        let cur2 = null;
        for (let k = sd2.candles.length - 1; k >= 0; k--) {
          if (sd2.candles[k].t <= curTs) { cur2 = sd2.candles[k]; break; }
        }
        if (cur2 && sd2.dayOpen) {
          sectorAtBar = {
            key: sectorKey,
            intradayPct: (cur2.c - sd2.dayOpen) / sd2.dayOpen,
          };
        }
      }

      const patterns = detectPatterns(candlesSoFar, {
        barIndex: barIdx,
        orbHigh: sd.orbHigh,
        orbLow: sd.orbLow,
        prevDayHigh: sd.prevDayHigh,
        prevDayLow: sd.prevDayLow,
        indexDirection: indexAtBar,
        stockDayOpen,
        sector: sectorAtBar,
      });
      const box = detectLiquidityBox(candlesSoFar);
      const risk = computeRiskScore({ candles: candlesSoFar, patterns, box, opts: { barIndex: barIdx, indexDirection: indexAtBar, orbHigh: sd.orbHigh, orbLow: sd.orbLow, prevDayHigh: sd.prevDayHigh, prevDayLow: sd.prevDayLow, margin: marginEnabled, marginMap, sym, stockDayOpen, sector: sectorAtBar } });

      if (risk.confidence < MIN_CONFIDENCE) continue;
      if (!ACTIONABLE.has(risk.action)) continue;

      // Apply 5x margin leverage when margin is enabled — Rs 3L capital
      // controls Rs 15L of stock. The per-trade P&L is calculated on the
      // leveraged exposure, matching how Indian intraday margin (MIS) works.
      const effectivePositionSize = marginEnabled ? POSITION_SIZE * MARGIN_MULTIPLIER : POSITION_SIZE;
      const shares = Math.floor(effectivePositionSize / risk.entry);
      if (shares < 1) continue;

      candidates.push({ sym, risk, patterns, shares });
    }

    // Sort by confidence descending, pick top candidates up to available slots
    candidates.sort((a, b) => b.risk.confidence - a.risk.confidence);
    for (const c of candidates) {
      if (openPositions.length >= MAX_POSITIONS) break;
      if (totalTradesOpened >= MAX_TOTAL_TRADES) break;

      openPositions.push({
        sym: c.sym, direction: c.risk.direction,
        entry: c.risk.entry, sl: c.risk.sl, target: c.risk.target,
        entryBar: barIdx, shares: c.shares,
        confidence: c.risk.confidence, action: c.risk.action,
        pattern: c.patterns[0]?.name || 'None',
        maxHoldBars: c.risk.maxHoldBars || null,
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
  const { timeframe, indexName, date: targetDate, engine, variant, minConfidence, maxPositions, maxTotalTrades, positionSize, skipFirstBars, capital, fromTime, toTime, multiWindow, margin } = parseArgs();

  let detectPatterns, detectLiquidityBox, computeRiskScore;
  if (engine === 'scalp') {
    const fns = getScalpVariantFns(variant);
    detectPatterns = fns.detectPatterns;
    detectLiquidityBox = fns.detectLiquidityBox;
    computeRiskScore = fns.computeRiskScore;
  } else {
    detectPatterns = detectPatternsV2;
    detectLiquidityBox = detectLiquidityBoxV2;
    computeRiskScore = computeRiskScoreV2;
  }
  const CAPITAL = capital;
  const tf = TIMEFRAME_MAP[timeframe];
  if (!tf) { console.error(`Unknown timeframe: ${timeframe}`); process.exit(1); }

  const variantLabel = engine === 'scalp' && variant !== 'momentum' ? ` [${variant}]` : '';
  console.log(`\n=== CandleScan ${engine}${variantLabel} Simulation${multiWindow ? ' (Multi-Window)' : ''} ===`);
  console.log(`Index: ${indexName} | Timeframe: ${timeframe} | Date: ${targetDate || 'latest'} | Engine: ${engine}`);
  console.log(`Capital: Rs.${CAPITAL.toLocaleString()} | Max concurrent: ${maxPositions} | Per trade: Rs.${positionSize.toLocaleString()} | Max trades: ${maxTotalTrades}`);
  console.log(`Min confidence: ${minConfidence} | Skip first ${skipFirstBars} bars | Volume: auto (25th pctile) | Margin: ${margin ? MARGIN_MULTIPLIER + 'x' : 'Off'}`);
  console.log('');

  // 1. Fetch index constituents (with cache fallback)
  console.log('Fetching index constituents...');
  let symbols;
  try {
    symbols = await fetchNseIndexSymbolsNode(indexName);
  } catch (e) {
    console.log(`NSE API failed (${e.message}), falling back to cached symbols...`);
    // Derive symbols from cached directory names
    symbols = listCachedSymbols()
      .filter(s => s.endsWith('.NS') && !s.startsWith('^'))
      .map(s => s.replace(/\.NS$/, ''));
  }
  console.log(`Got ${symbols.length} symbols\n`);

  // 2. Resolve target date — use explicit date or latest cached
  let resolvedDate = targetDate;
  if (!resolvedDate) {
    // Find latest cached date from first available symbol
    for (const sym of symbols) {
      const yahooSym = `${sym}.NS`;
      const latest = getLatestCachedDate(yahooSym, tf.interval);
      if (latest) { resolvedDate = latest; break; }
    }
    if (!resolvedDate) {
      console.log('No cached data found. Run cache warming first: npm run cache:march');
      process.exit(0);
    }
  }
  const prevDate = getPrevTradingDate(resolvedDate);

  // 3. Load candle data — cache-first, auto-fetch on miss for past dates, live for today
  const todayIst = istDateStr(Math.floor(Date.now() / 1000));
  const isToday = resolvedDate === todayIst;
  console.log(`Loading candle data for ${resolvedDate}${isToday ? ' (TODAY — live fetch)' : ' (cache-first, auto-fetch on miss)'}...`);
  const allStockBase = {};
  let loaded = 0;
  let fetchedLive = 0;
  const filterStats = { total: symbols.length, noCandles: 0, loaded: 0 };
  for (const sym of symbols) {
    const yahooSym = `${sym}.NS`;
    try {
      let dayCandles;
      if (isToday) {
        // Today: always fetch live, write to cache for the session
        try {
          const json = await fetchYahooChartForDate(yahooSym, tf.interval, resolvedDate);
          writeCachedChartJson(yahooSym, tf.interval, resolvedDate, json);
          const parsed = parseChartJson(json);
          dayCandles = parsed?.candles?.length ? trimTrailingFlatCandles(parsed.candles) : null;
          fetchedLive++;
          await new Promise(r => setTimeout(r, 200)); // throttle live fetches
        } catch { dayCandles = null; }
      } else {
        // Past date: cache-first, auto-fetch on miss and cache the result
        const hadCache = !!readCachedChartJson(yahooSym, tf.interval, resolvedDate);
        dayCandles = await getCandles(yahooSym, tf.interval, resolvedDate);
        if (dayCandles && !hadCache) {
          fetchedLive++;
          await new Promise(r => setTimeout(r, 200)); // throttle fetches
        }
      }
      if (!dayCandles?.length || dayCandles.length < 5) { filterStats.noCandles++; continue; }

      // Read previous trading day for prior candles, prevDayHigh/Low
      let priorCandles = [];
      let prevDayHigh = null;
      let prevDayLow = null;
      // For prev day, also auto-fetch on miss (but don't fail if unavailable)
      try {
        const prevCandles = await getCandles(yahooSym, tf.interval, prevDate);
        if (prevCandles?.length) {
          priorCandles = prevCandles.slice(-20);
          prevDayHigh = Math.max(...prevCandles.map(c => c.h));
          prevDayLow = Math.min(...prevCandles.map(c => c.l));
        }
      } catch { /* prev day unavailable — ok */ }

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
  if (fetchedLive) console.log(`  ${fetchedLive} fetched live from Yahoo (auto-cached)`);
  console.log(`  ${filterStats.noCandles} filtered: no valid candles`);
  console.log(`  ${filterStats.loaded} passed → loaded for simulation`);

  if (!loaded) {
    console.log(`No data available for ${resolvedDate}.`);
    process.exit(0);
  }

  const simDate = resolvedDate;
  console.log(`Simulation date: ${simDate}`);
  console.log('─'.repeat(100));

  // Compute index direction — use same symbol mapping as browser (indexDirection.js)
  // All indices use NIFTY 50 (^NSEI) as the market-direction proxy.
  // The broader NIFTY is the most reliable intraday reference and small
  // caps strongly correlate with it (beta ~1.1-1.3). Dedicated small-cap
  // index data is often sparse/delayed on Yahoo, so ^NSEI is preferred.
  const INDEX_SYMBOL_MAP = {
    'NIFTY 50': '^NSEI', 'NIFTY NEXT 50': '^NSEI', 'NIFTY 100': '^NSEI', 'NIFTY 200': '^NSEI',
    'NIFTY MIDCAP 50': '^NSEI', 'NIFTY MIDCAP 100': '^NSEI', 'NIFTY MIDCAP 150': '^NSEI',
    'NIFTY SMALLCAP 50': '^NSEI', 'NIFTY SMALLCAP 100': '^NSEI', 'NIFTY SMALLCAP 250': '^NSEI',
  };
  // Load NIFTY candles for the full day so each bar can compute index
  // relative strength at that moment (no lookahead). We store the raw
  // candle array on indexDirection so pattern/risk engines can look up
  // the index intraday % at any given timestamp.
  let indexDirection = { direction: 'neutral', strength: 0, candles: null, dayOpen: null };
  if (engine === 'scalp') {
    const niftySym = INDEX_SYMBOL_MAP[indexName] || '^NSEI';
    const niftyJson = readCachedChartJson(niftySym, tf.interval, resolvedDate);
    if (niftyJson) {
      const niftyParsed = parseChartJson(niftyJson);
      if (niftyParsed?.candles?.length >= 15) {
        const [fromH, fromM] = fromTime.split(':').map(Number);
        const fromMins = fromH * 60 + fromM;
        const IST_OFFSET = 19800;
        const niftyCandles = niftyParsed.candles;
        // Pre-window direction — established before trading starts
        const candlesUpToStart = niftyCandles.filter(c => {
          const d = new Date((c.t + IST_OFFSET) * 1000);
          return d.getUTCHours() * 60 + d.getUTCMinutes() < fromMins;
        });
        if (candlesUpToStart.length >= 5) {
          const first = candlesUpToStart[0];
          const last = candlesUpToStart[candlesUpToStart.length - 1];
          const move = (last.c - first.o) / first.o;
          const absMove = Math.abs(move);
          indexDirection = {
            direction: move > 0.0015 ? 'bullish' : move < -0.0015 ? 'bearish' : 'neutral',
            strength: Math.min(1, absMove * 100),
            candles: niftyCandles,        // full day — pattern engine filters by ts
            dayOpen: first.o,             // the index's session open price
            preWindowMove: move,          // net % move during the pre-window
          };
          console.log(`Index direction: ${indexDirection.direction} (pre-window move: ${(move * 100).toFixed(2)}%)`);
        }
      }
    } else {
      console.log('Warning: NIFTY cache not found — index direction filter disabled');
    }
  }

  // ── Sector index loading ──────────────────────────────────────
  // Load 1m candles for every NIFTY sector index we know about.
  // Each entry: { candles: [...], dayOpen: number } keyed by sector code.
  // Used by pattern/risk engines to score a stock's sector strength
  // vs the broader market at the time of the signal (no lookahead —
  // we look up the latest sector bar at or before the stock bar's ts).
  const sectorData = {};
  if (engine === 'scalp') {
    for (const [sectorKey, yahooSym] of Object.entries(SECTOR_INDEX_SYMBOLS)) {
      const json = readCachedChartJson(yahooSym, tf.interval, resolvedDate);
      if (!json) continue;
      const parsed = parseChartJson(json);
      if (!parsed?.candles?.length) continue;
      sectorData[sectorKey] = {
        candles: parsed.candles,
        dayOpen: parsed.candles[0]?.o || null,
      };
    }
    const loadedSectors = Object.keys(sectorData).length;
    if (loadedSectors > 0) {
      console.log(`Sector indices loaded: ${loadedSectors}/${Object.keys(SECTOR_INDEX_SYMBOLS).length}`);
    }
  }

  // Fetch margin eligibility map if margin trading is enabled
  let marginMap = null;
  if (margin) {
    try {
      marginMap = await fetchMarginMapNode();
      console.log(`Margin data loaded: ${marginMap.size} stocks`);
    } catch { console.log('Warning: Could not fetch margin data — margin penalty disabled'); }
  }

  const simParams = { detectPatterns, detectLiquidityBox, computeRiskScore, MIN_CONFIDENCE: minConfidence, MAX_POSITIONS: maxPositions, POSITION_SIZE: positionSize, CAPITAL, SKIP_FIRST_BARS: skipFirstBars, MAX_TOTAL_TRADES: maxTotalTrades, indexDirection, marginEnabled: margin, marginMap, sectorData };

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
