#!/usr/bin/env node
/**
 * Replay reference trades — Phase 0.5 gating script.
 *
 * Takes a hardcoded list of peer-validated trades (from the strategy
 * iteration plan) and tries to reproduce each one with the current
 * scalp + intraday engines. The output answers a single question per
 * trade: would our engine have surfaced this signal?
 *
 * For each (symbol, date, engine, timeframe) combination:
 *   1. Fetch the day's candles (cache-first; auto-fetch from Yahoo on
 *      miss, like simulate-day.mjs)
 *   2. Walk every bar and run detectPatterns + detectLiquidityBox +
 *      computeRiskScore
 *   3. Track the highest-confidence signal (if any)
 *   4. Compare against the peer's entry / direction / target tier
 *
 * Output: a markdown table that lights up the diagnostic that drives
 * Phase 1+ scope. Possible diagnostics:
 *   - "engine fired" — replicates the peer setup
 *   - "no fire (engine has no momentum-runner)" — needs Phase 2 pattern work
 *   - "fire below conf threshold (X<75)" — needs scoring rebalance
 *   - "fetch failed" — symbol not on Yahoo / data missing
 *
 * Per the plan: this is a HARD GATE on PR-B/C/D. If <6/8 trades fire
 * under the right engine, the engine pattern logic itself needs rework
 * before downstream tuning can matter.
 *
 * Usage:
 *   node scripts/replay-reference-trades.mjs                # all 8, all engines
 *   node scripts/replay-reference-trades.mjs --engine scalp # just scalp
 *   node scripts/replay-reference-trades.mjs --symbol REFEX # just one symbol
 */

import { detectPatterns as detectPatternsScalp } from '../src/engine/patterns-scalp.js';
import { detectLiquidityBox as detectLiquidityBoxScalp } from '../src/engine/liquidityBox-scalp.js';
import { computeRiskScore as computeRiskScoreScalp } from '../src/engine/risk-scalp.js';
import { detectPatterns as detectPatternsV2 } from '../src/engine/patterns-v2.js';
import { detectLiquidityBox as detectLiquidityBoxV2 } from '../src/engine/liquidityBox-v2.js';
import { computeRiskScore as computeRiskScoreV2 } from '../src/engine/risk-v2.js';
import { trimTrailingFlatCandles } from '../src/engine/fetcher.js';
import { readCachedChartJson, writeCachedChartJson } from './lib/chart-cache-fs.mjs';

// ── Reference trades (all intraday, peer-validated; from plan PR-A2) ──
const REFERENCE_TRADES = [
  { symbol: 'MMFL',       date: '2026-04-22', direction: 'long', entry: 510,  target1: 610,  sl: null, note: 'Intraday momentum runner +19.6%' },
  { symbol: 'SAILIFE',    date: '2026-04-22', direction: 'long', entry: 989,  target1: 1108, sl: 892,  note: 'Intraday + add-on at 945-950' },
  { symbol: 'REFEX',      date: '2026-04-21', direction: 'long', entry: 257,  target1: 262,  sl: 253,  note: 'Intraday breakout' },
  { symbol: 'ASHAPURMIN', date: '2026-04-21', direction: 'long', entry: 635,  target1: 700,  sl: 575,  note: 'Intraday momentum runner +10%' },
  { symbol: 'REFEX',      date: '2026-04-20', direction: 'long', entry: 250,  target1: 256,  sl: 244,  note: 'Intraday breakout' },
  { symbol: 'RRKABEL',    date: '2026-04-20', direction: 'long', entry: 1506, target1: 1600, sl: 1445, note: 'Intraday +6.2%' },
  { symbol: 'GRAPHITE',   date: '2026-04-17', direction: 'long', entry: 685,  target1: 694,  sl: 676,  note: 'Intraday (scalp-feasible)' },
  { symbol: 'SYRMA',      date: '2026-04-17', direction: 'long', entry: 974,  target1: 1000, sl: 955,  note: 'Intraday' },
];

const ENGINES = {
  scalp: {
    timeframes: ['1m'],
    detectPatterns: detectPatternsScalp,
    detectLiquidityBox: detectLiquidityBoxScalp,
    computeRiskScore: computeRiskScoreScalp,
  },
  intraday: {
    timeframes: ['5m', '15m'],
    detectPatterns: detectPatternsV2,
    detectLiquidityBox: detectLiquidityBoxV2,
    computeRiskScore: computeRiskScoreV2,
  },
  // delivery: deferred to PR-D (no daily-bar simulator yet)
};

function parseArgs() {
  const opts = { engine: null, symbol: null };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--engine' && args[i + 1]) { opts.engine = args[++i]; continue; }
    if (args[i] === '--symbol' && args[i + 1]) { opts.symbol = args[++i].toUpperCase(); continue; }
  }
  return opts;
}

function parseChartJson(data) {
  const r = data?.chart?.result?.[0];
  if (!r) return null;
  const ts = r.timestamp;
  const q = r.indicators?.quote?.[0];
  if (!ts?.length || !q) return null;
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({ t: ts[i], o, h, l, c, v: q.volume?.[i] ?? 0 });
  }
  return candles.length ? candles : null;
}

async function fetchYahoo(symbol, interval, date) {
  const [y, m, d] = date.split('-').map(Number);
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

async function getCandles(yahooSym, interval, date) {
  let json = readCachedChartJson(yahooSym, interval, date);
  if (!json) {
    json = await fetchYahooChartForDateSafe(yahooSym, interval, date);
    if (!json) return null;
    try { writeCachedChartJson(yahooSym, interval, date, json); } catch { /* ok */ }
  }
  const parsed = parseChartJson(json);
  return parsed ? trimTrailingFlatCandles(parsed) : null;
}

async function fetchYahooChartForDateSafe(symbol, interval, date) {
  try {
    return await fetchYahoo(symbol, interval, date);
  } catch (e) {
    return null;
  }
}

function getPrevTradingDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Walk back day-by-day, skip Sat/Sun. NSE holidays not handled — replay
  // tolerates a one-day gap for prevDay context (returns null candles).
  for (let i = 1; i <= 5; i++) {
    dt.setUTCDate(dt.getUTCDate() - 1);
    const dow = dt.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      return dt.toISOString().slice(0, 10);
    }
  }
  return null;
}

/**
 * Replay one (trade × engine × timeframe) combination.
 * Walks every bar of the day, runs the engine pipeline, returns the
 * highest-confidence actionable signal (if any).
 */
async function replayOne(trade, engineName, timeframe) {
  const eng = ENGINES[engineName];
  const yahooSym = `${trade.symbol}.NS`;

  const dayCandles = await getCandles(yahooSym, timeframe, trade.date);
  if (!dayCandles?.length) {
    return { status: 'fetch-failed', diagnostic: `no ${timeframe} data for ${trade.symbol} on ${trade.date}` };
  }

  // Previous day for prev-day high/low context (used by patterns-scalp)
  let prevDayHigh = null, prevDayLow = null;
  const prevDate = getPrevTradingDate(trade.date);
  if (prevDate) {
    const prev = await getCandles(yahooSym, timeframe, prevDate);
    if (prev?.length) {
      prevDayHigh = Math.max(...prev.map(c => c.h));
      prevDayLow = Math.min(...prev.map(c => c.l));
    }
  }

  // Opening range (first 15 bars) for ORB context
  const orbBars = dayCandles.slice(0, 15);
  const orbHigh = orbBars.length >= 5 ? Math.max(...orbBars.map(c => c.h)) : null;
  const orbLow = orbBars.length >= 5 ? Math.min(...orbBars.map(c => c.l)) : null;

  // Track BOTH the best-overall signal and the best-aligned (peer's
  // direction) signal. Reporting the aligned one answers the actually-
  // useful question: "would the engine have surfaced THIS peer trade?"
  // — not "did the engine fire something at any point?"
  let bestOverall = null;
  let bestAligned = null;
  for (let barIdx = 5; barIdx < dayCandles.length; barIdx++) {
    const candlesSoFar = dayCandles.slice(0, barIdx + 1);
    const patterns = eng.detectPatterns(candlesSoFar, {
      barIndex: barIdx,
      prevDayHigh, prevDayLow, orbHigh, orbLow,
    });
    if (!patterns?.length) continue;
    const box = eng.detectLiquidityBox(candlesSoFar);
    const risk = eng.computeRiskScore({
      candles: candlesSoFar,
      patterns,
      box,
      opts: { barIndex: barIdx, prevDayHigh, prevDayLow, orbHigh, orbLow, sym: trade.symbol },
    });
    if (!risk || !risk.confidence) continue;
    const snap = {
      confidence: risk.confidence,
      action: risk.action,
      direction: risk.direction,
      entry: risk.entry,
      sl: risk.sl,
      target: risk.target,
      rr: risk.rr,
      pattern: patterns[0]?.name,
      barIdx,
      barTime: new Date(candlesSoFar[candlesSoFar.length - 1].t * 1000).toISOString(),
    };
    if (!bestOverall || snap.confidence > bestOverall.confidence) bestOverall = snap;
    if (snap.direction === trade.direction && (!bestAligned || snap.confidence > bestAligned.confidence)) {
      bestAligned = snap;
    }
  }

  if (!bestOverall) {
    return { status: 'no-signal', diagnostic: `no pattern fired across ${dayCandles.length} bars` };
  }

  // Prefer aligned signal for the diagnostic; fall back to best-overall
  // (which will be wrong-direction) only if no aligned signal at all.
  const best = bestAligned || bestOverall;
  const directionMatch = best.direction === trade.direction;
  const entryDelta = trade.entry ? ((best.entry - trade.entry) / trade.entry) * 100 : null;
  const passesConfGate = best.confidence >= 75;

  let status, diagnostic;
  if (!directionMatch) {
    status = 'wrong-direction';
    diagnostic = `no signal in peer's direction; best-overall was ${best.direction} conf ${best.confidence}`;
  } else if (!passesConfGate) {
    status = 'sub-threshold';
    diagnostic = `fired ${best.direction} but conf ${best.confidence} < 75 (action="${best.action}")`;
  } else {
    status = 'fired';
    diagnostic = `${best.action} @ Rs ${best.entry?.toFixed(2)} (peer Rs ${trade.entry}, Δ${entryDelta?.toFixed(1)}%), conf ${best.confidence}`;
  }

  return { status, diagnostic, best };
}

async function main() {
  const opts = parseArgs();
  const trades = opts.symbol
    ? REFERENCE_TRADES.filter(t => t.symbol === opts.symbol)
    : REFERENCE_TRADES;
  if (trades.length === 0) {
    console.error(`No reference trades match --symbol ${opts.symbol}`);
    process.exit(1);
  }

  const enginesToRun = opts.engine
    ? { [opts.engine]: ENGINES[opts.engine] }
    : ENGINES;

  console.log('# Reference Trade Replay');
  console.log('');
  console.log(`Window: ${trades[0].date} → ${trades[trades.length - 1].date}, ${trades.length} trades, ${Object.keys(enginesToRun).join(' + ')} engines`);
  console.log('');

  const results = [];
  for (const trade of trades) {
    for (const [engineName, eng] of Object.entries(enginesToRun)) {
      for (const tf of eng.timeframes) {
        process.stderr.write(`  replaying ${trade.symbol} ${trade.date} [${engineName}/${tf}]...\n`);
        const r = await replayOne(trade, engineName, tf);
        results.push({ trade, engineName, timeframe: tf, ...r });
      }
    }
  }

  // Markdown table
  console.log('| Symbol | Date | Engine | TF | Status | Diagnostic |');
  console.log('|---|---|---|---|---|---|');
  for (const r of results) {
    const status = r.status === 'fired'         ? '✅ FIRED'
                 : r.status === 'sub-threshold' ? '⚠️ SUB-THRESHOLD'
                 : r.status === 'wrong-direction' ? '❌ WRONG-DIR'
                 : r.status === 'no-signal'     ? '⏸ NO-SIGNAL'
                 : '⚠ FETCH-FAIL';
    console.log(`| ${r.trade.symbol} | ${r.trade.date} | ${r.engineName} | ${r.timeframe} | ${status} | ${r.diagnostic} |`);
  }

  // Summary
  console.log('');
  const tradeKeys = [...new Set(results.map(r => `${r.trade.symbol}@${r.trade.date}`))];
  const firedTrades = new Set(
    results.filter(r => r.status === 'fired').map(r => `${r.trade.symbol}@${r.trade.date}`)
  );
  console.log(`## Summary: ${firedTrades.size}/${tradeKeys.length} trades fire under at least one engine/timeframe`);
  console.log('');
  if (firedTrades.size < 6) {
    console.log('**< 6/8 trades fire — engine pattern logic likely needs rework. See plan PR-C (intraday momentum runner).**');
  } else {
    console.log('**≥ 6/8 trades fire — engine logic is sufficient; downstream tuning (PR-B/E) can proceed.**');
  }

  // Exit code: 0 if ≥6/8 fire; 1 otherwise (so CI / harness can gate on it)
  process.exit(firedTrades.size >= 6 ? 0 : 1);
}

main().catch((e) => { console.error('Replay failed:', e); process.exit(2); });
