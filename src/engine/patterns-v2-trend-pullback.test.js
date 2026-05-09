/**
 * Guard tests for the Trend Continuation Pullback pattern
 * (v11 — peer-validated independent backtest, see
 * cache/independent-analysis/REFERENCE.md).
 *
 * Pattern fires when:
 *   - barIndex in [13, 50] (post-first-hour, no late-day chop)
 *   - First-hour move ≥ 0.7% in one direction and ≥ 1.5× the opposite tail
 *   - 30m + 60m bars aligned with first-hour direction
 *   - Current bar's low (LONG) / high (SHORT) within 0.2% of session VWAP
 *   - Current bar bullish + closes above VWAP (LONG); mirror for SHORT
 *   - Volume ≥ 2× prior 6-bar avg
 *   - First 30 min turnover ≥ Rs 1cr
 *   - Optional morning-only filter rejects entries after 10:30 IST
 */
import { describe, it, expect } from 'vitest';
import { detectPatterns } from './patterns-v2.js';
import { computeRiskScore, TREND_CONT_PULLBACK_DEFAULTS } from './risk-v2.js';

const IST_OFFSET = 19800;

/** Build a bar with a 5m IST timestamp for `mins` past 9:15. */
function bar5m(mins, o, h, l, c, v) {
  // 9:15 IST = 09:15 - 5:30 = 03:45 UTC. We use 2026-04-22 as the anchor.
  const baseUtc = Date.UTC(2026, 3, 22, 3, 45, 0) / 1000;
  const t = baseUtc + mins * 60;
  return { o, h, l, c, v, t };
}

/**
 * Build a synthetic 5m session that:
 *   1. Runs from `dayOpen` up to `firstHourPct` over the first hour (12 bars)
 *   2. Pulls back to roughly VWAP with several bars
 *   3. Bounces with a high-volume bullish bar at `triggerBarIdx`
 *
 * Designed to satisfy every gate of the Trend Continuation Pullback pattern.
 */
function buildTrendPullbackSession({
  dayOpen = 100,
  firstHourPct = 0.012,  // +1.2% in first hour (clears the 0.7% gate)
  pullbackBars = 2,
  triggerBarIdx = 14,
  vol30m = 50000,        // turnover = 100 * 50000 * 6 = Rs 3cr — clears 1cr gate
  surgeVolMult = 3,
} = {}) {
  const bars = [];
  const peakAfter1h = dayOpen * (1 + firstHourPct);
  // First hour: linear ramp from dayOpen to peakAfter1h over 12 bars.
  for (let i = 0; i < 12; i++) {
    const frac = i / 11;
    const c = dayOpen + (peakAfter1h - dayOpen) * frac;
    const o = i === 0 ? dayOpen : bars[i - 1].c;
    const h = Math.max(o, c) * 1.0008;
    const l = Math.min(o, c) * 0.9992;
    bars.push(bar5m(i * 5, o, h, l, c, vol30m));
  }
  // Pullback bars: drift down toward VWAP.
  for (let j = 0; j < pullbackBars; j++) {
    const i = 12 + j;
    const o = bars[i - 1].c;
    const c = o * 0.9985;
    const h = Math.max(o, c) * 1.0005;
    const l = Math.min(o, c) * 0.999;
    bars.push(bar5m(i * 5, o, h, l, c, Math.round(vol30m * 0.6)));
  }
  // Pad if triggerBarIdx is further out
  while (bars.length < triggerBarIdx) {
    const i = bars.length;
    const o = bars[i - 1].c;
    const c = o * 1.0001;
    const h = Math.max(o, c) * 1.0005;
    const l = Math.min(o, c) * 0.999;
    bars.push(bar5m(i * 5, o, h, l, c, Math.round(vol30m * 0.5)));
  }

  // Compute current VWAP up to (but excluding) the trigger bar
  let pv = 0, vv = 0;
  for (const b of bars) { const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; vv += b.v; }
  const vwapNow = pv / vv;

  // Trigger bar: bullish, low touches VWAP within 0.2%, closes above VWAP, vol spike.
  const o = vwapNow * 1.0005;
  const l = vwapNow * 0.9990;     // pulls below VWAP slightly (within 0.2%)
  const c = vwapNow * 1.0030;     // closes well above VWAP
  const h = c * 1.0005;
  const surgeVol = Math.round(vol30m * surgeVolMult);
  bars.push(bar5m(triggerBarIdx * 5, o, h, l, c, surgeVol));
  return bars;
}

describe('Trend Continuation Pullback — long', () => {
  it('fires on a +1.2% morning trend with VWAP pullback + 3× volume bounce', () => {
    const candles = buildTrendPullbackSession({});
    const patterns = detectPatterns(candles, {
      barIndex: candles.length - 1,
      stockDayOpen: candles[0].o,
    });
    const pullback = patterns.find(p => p.name === 'Trend Continuation Pullback');
    expect(pullback).toBeDefined();
    expect(pullback.direction).toBe('bullish');
    expect(pullback.strength).toBeGreaterThanOrEqual(0.80);
    expect(pullback.strength).toBeLessThanOrEqual(0.86);
    expect(pullback.reliability).toBe(0.70);
    expect(pullback._structureSL).toBeGreaterThan(0);
    expect(pullback._firstHourMove).toBeGreaterThan(0.007);
  });

  it('does NOT fire when first-hour move is below 0.7% (only 0.4%)', () => {
    const candles = buildTrendPullbackSession({ firstHourPct: 0.004 });
    const patterns = detectPatterns(candles, {
      barIndex: candles.length - 1,
      stockDayOpen: candles[0].o,
    });
    expect(patterns.find(p => p.name === 'Trend Continuation Pullback')).toBeUndefined();
  });

  it('does NOT fire before the first hour completes (bar 11)', () => {
    const candles = buildTrendPullbackSession({ triggerBarIdx: 11 });
    const patterns = detectPatterns(candles, {
      barIndex: 11,
      stockDayOpen: candles[0].o,
    });
    expect(patterns.find(p => p.name === 'Trend Continuation Pullback')).toBeUndefined();
  });

  it('does NOT fire after 10:30 IST when morningOnly is on (default)', () => {
    // Bar index 16 = 9:15 + 16*5 min = 10:35 IST → past the morning cutoff
    const candles = buildTrendPullbackSession({ triggerBarIdx: 16 });
    const patterns = detectPatterns(candles, {
      barIndex: candles.length - 1,
      stockDayOpen: candles[0].o,
    });
    expect(patterns.find(p => p.name === 'Trend Continuation Pullback')).toBeUndefined();
  });

  it('DOES fire after 10:30 IST when morningOnly=false', () => {
    const candles = buildTrendPullbackSession({ triggerBarIdx: 16 });
    const patterns = detectPatterns(candles, {
      barIndex: candles.length - 1,
      stockDayOpen: candles[0].o,
      morningOnly: false,
    });
    expect(patterns.find(p => p.name === 'Trend Continuation Pullback')).toBeDefined();
  });

  it('does NOT fire when liquidity gate fails (turnover < 1cr in first 30 min)', () => {
    // 100 * 100 * 6 = Rs 60k < 1cr → gate fails
    const candles = buildTrendPullbackSession({ vol30m: 100 });
    const patterns = detectPatterns(candles, {
      barIndex: candles.length - 1,
      stockDayOpen: candles[0].o,
    });
    expect(patterns.find(p => p.name === 'Trend Continuation Pullback')).toBeUndefined();
  });

  it('does NOT fire when volume burst is < 2× prior 6-bar avg (1.2× surge)', () => {
    const candles = buildTrendPullbackSession({ surgeVolMult: 1.2 });
    const patterns = detectPatterns(candles, {
      barIndex: candles.length - 1,
      stockDayOpen: candles[0].o,
    });
    expect(patterns.find(p => p.name === 'Trend Continuation Pullback')).toBeUndefined();
  });
});

describe('Trend Continuation Pullback — risk integration', () => {
  it('risk engine returns tight 0.4% target + structure SL + 3-tranche ladder', () => {
    const candles = buildTrendPullbackSession({});
    const patterns = detectPatterns(candles, {
      barIndex: candles.length - 1,
      stockDayOpen: candles[0].o,
    });
    const top = patterns[0];
    expect(top.name).toBe('Trend Continuation Pullback');

    const risk = computeRiskScore({
      candles, patterns, box: null,
      opts: { barIndex: candles.length - 1, stockDayOpen: candles[0].o },
    });
    expect(risk.tranches).toBeDefined();
    expect(risk.tranches).not.toBeNull();
    expect(risk.tranches.length).toBe(3);

    const targetPct = (risk.target - risk.entry) / risk.entry;
    expect(Math.abs(targetPct - TREND_CONT_PULLBACK_DEFAULTS.targetPct)).toBeLessThan(1e-6);
    // Tranche pcts sum to 1.0
    const sumPct = risk.tranches.reduce((s, t) => s + t.pct, 0);
    expect(Math.abs(sumPct - 1)).toBeLessThan(1e-9);
    // T1 target ~0.2% above entry; T3 target = full target
    const t1Pct = (risk.tranches[0].target - risk.entry) / risk.entry;
    expect(Math.abs(t1Pct - 0.002)).toBeLessThan(1e-6);
    // EOD-hold flag
    expect(risk.holdToEod).toBe(true);
    // Pullback uses 1:1 RR, not the default 1.5:1 floor — so action stays
    // actionable even though rrClamped is ~1.0
    expect(['BUY', 'STRONG BUY']).toContain(risk.action);
  });
});
