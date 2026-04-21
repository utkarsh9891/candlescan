/**
 * Phase A P0 #2: verify pessimistic-fills behaviour in the browser simulator.
 *
 * What we prove:
 *   1. Default (pessimisticFills undefined / true): entry buys at a higher
 *      price, exit sells at a lower price, so net P&L is worse than legacy.
 *   2. Legacy (pessimisticFills: false): fills land at exact engine prices
 *      and SL-first-always on straddle bars — reproducing the old baseline.
 *   3. Straddle-bar heuristic: when a bar touches both SL and target, a
 *      bullish bar exits at TARGET under pessimistic, always SL under legacy.
 */
import { describe, it, expect, vi } from 'vitest';
import { runSimulation } from './simulateDay.js';

vi.mock('./nseIndexFetch.js', () => ({
  fetchNseIndexSymbolList: vi.fn(async () => ['TEST']),
}));

// IST 09:15 = 03:45 UTC on 2026-04-10.
const DAY_START_TS = Math.floor(Date.UTC(2026, 3, 10, 3, 45, 0) / 1000);
const ONE_MIN = 60;

/** Build a day of 1m candles: 50 bars of flat open-range + a trigger bar + straddle bar. */
function buildCandles({ straddleBullish }) {
  const candles = [];
  // Pre-window / ORB region: 15 bars at price ~100 (flat).
  for (let i = 0; i < 15; i++) {
    candles.push({ t: DAY_START_TS + i * ONE_MIN, o: 100, h: 100.2, l: 99.8, c: 100, v: 100000 });
  }
  // Bars 15..19 (09:30–09:34): setup region with a mild up-move so the mocked engine
  // can treat this as a long signal. Price climbs to ~101.
  for (let i = 15; i < 20; i++) {
    const p = 100 + (i - 14) * 0.2;
    candles.push({ t: DAY_START_TS + i * ONE_MIN, o: p - 0.1, h: p + 0.1, l: p - 0.2, c: p, v: 100000 });
  }
  // Bar 20 — "straddle" bar: reaches BOTH SL (95) and target (105) in the same minute.
  // Direction controlled by straddleBullish (close vs open).
  const straddleOpen = 101;
  const straddleClose = straddleBullish ? 104 : 97;
  candles.push({
    t: DAY_START_TS + 20 * ONE_MIN,
    o: straddleOpen,
    h: 106, // >= target (105)
    l: 94,  // <= SL (95)
    c: straddleClose,
    v: 200000,
  });
  // Remaining bars — flat to EOD so any still-open pos closes EOD without noise.
  for (let i = 21; i < 45; i++) {
    candles.push({ t: DAY_START_TS + i * ONE_MIN, o: 101, h: 101.2, l: 100.8, c: 101, v: 100000 });
  }
  return candles;
}

/** Mock engine: always fires a long signal on bar 19 (the bar before the straddle). */
const engineFns = {
  detectPatterns: vi.fn(() => [{ name: 'TEST', direction: 'long' }]),
  detectLiquidityBox: vi.fn(() => null),
  computeRiskScore: vi.fn(({ candles, opts }) => {
    // Fire only at/after bar 19 within the window. barIndex is the index
    // within the window (start 09:30) so bar 19 corresponds to window bar 4.
    if ((opts?.barIndex ?? 0) !== 4) {
      return { action: 'HOLD', confidence: 0, direction: null, entry: 0, sl: 0, target: 0, maxHoldBars: null };
    }
    // Entry 100, SL 95, Target 105 — deliberately tight so the next bar straddles.
    return {
      action: 'STRONG BUY',
      confidence: 90,
      direction: 'long',
      entry: 100,
      sl: 95,
      target: 105,
      maxHoldBars: null,
    };
  }),
};

async function runOnce(pessimisticFills, straddleBullish) {
  const candles = buildCandles({ straddleBullish });
  const fetchFn = vi.fn(async () => ({ candles }));
  const res = await runSimulation({
    indexName: 'TEST',
    timeframe: '1m',
    date: '2026-04-10',
    startTime: '09:30',
    endTime: '10:30',
    engineFns,
    capital: 300000,
    positionSize: 300000,
    maxConcurrent: 1,
    maxTotalTrades: 1,
    minConfidence: 75,
    skipFirstBars: 0,
    fetchFn,
    pessimisticFills,
  });
  return res;
}

describe('pessimistic fills — Phase A P0 #2', () => {
  it('legacy mode (pessimisticFills: false) fills at exact engine prices and SL-first on straddle', async () => {
    const res = await runOnce(false, /*straddleBullish*/ true);
    expect(res.trades.length).toBe(1);
    const t = res.trades[0];
    expect(t.entry).toBeCloseTo(100, 8);
    // Legacy: always SL-first on straddle (exit at 95, exact, no slippage).
    expect(t.exit).toBeCloseTo(95, 8);
    expect(t.reason).toBe('SL');
  });

  it('pessimistic mode applies slippage: entry higher, exit lower on longs', async () => {
    const resLegacy = await runOnce(false, /*straddleBullish*/ false);
    const resPess = await runOnce(true, /*straddleBullish*/ false);
    expect(resLegacy.trades.length).toBe(1);
    expect(resPess.trades.length).toBe(1);
    const legacy = resLegacy.trades[0];
    const pess = resPess.trades[0];
    // Bearish straddle bar => both modes exit at SL. Compare prices to isolate slippage.
    expect(legacy.reason).toBe('SL');
    expect(pess.reason).toBe('SL');
    expect(pess.entry).toBeGreaterThan(legacy.entry); // buy higher
    expect(pess.exit).toBeLessThan(legacy.exit);       // sell lower
    expect(pess.netPnl).toBeLessThan(legacy.netPnl);   // worse P&L
  });

  it('pessimistic mode uses bar direction as intra-bar fill proxy (bullish bar → TARGET)', async () => {
    const resLegacy = await runOnce(false, /*straddleBullish*/ true);
    const resPess = await runOnce(true, /*straddleBullish*/ true);
    // Legacy always picks SL on straddle.
    expect(resLegacy.trades[0].reason).toBe('SL');
    // Pessimistic: bullish bar → target-first.
    expect(resPess.trades[0].reason).toBe('TARGET');
    // Even with slippage pulling the exit down, TARGET (~105 * 0.9997) > SL (~95).
    expect(resPess.trades[0].exit).toBeGreaterThan(resLegacy.trades[0].exit);
    expect(resPess.trades[0].netPnl).toBeGreaterThan(resLegacy.trades[0].netPnl);
  });

  it('pessimistic fills is default ON when option is omitted', async () => {
    const candles = buildCandles({ straddleBullish: false });
    const fetchFn = vi.fn(async () => ({ candles }));
    const res = await runSimulation({
      indexName: 'TEST',
      timeframe: '1m',
      date: '2026-04-10',
      startTime: '09:30',
      endTime: '10:30',
      engineFns,
      capital: 300000,
      positionSize: 300000,
      maxConcurrent: 1,
      maxTotalTrades: 1,
      minConfidence: 75,
      skipFirstBars: 0,
      fetchFn,
      // pessimisticFills omitted — expect default ON
    });
    expect(res.trades.length).toBe(1);
    // Entry buys higher than 100 due to slippage being applied by default.
    expect(res.trades[0].entry).toBeGreaterThan(100);
  });
});
