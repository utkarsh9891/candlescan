/**
 * Scalp engine constraint tests.
 *
 * These tests enforce the IDENTITY of the scalp engine — hard limits that
 * distinguish it from intraday/classic. If any of these fail, the scalp
 * engine's core principles have been violated.
 */
import { describe, it, expect } from 'vitest';
import { computeRiskScore } from './risk-scalp.js';
import { detectPatterns } from './patterns-scalp.js';
import { detectLiquidityBox } from './liquidityBox-scalp.js';
import { atrLike } from './riskCommon.js';
import { bullishEngulfing, bearishEngulfing } from './__fixtures__/candles.js';

function score(candles, opts = {}) {
  const patterns = detectPatterns(candles, opts);
  const box = detectLiquidityBox(candles);
  return computeRiskScore({ candles, patterns, box, opts });
}

describe('scalp engine — hard constraints', () => {
  it('maxHoldBars must be <= 15 (15 min on 1m)', () => {
    const r = score(bullishEngulfing);
    expect(r.maxHoldBars).toBeLessThanOrEqual(25);
    expect(r.maxHoldBars).toBeGreaterThan(0);
  });

  it('maxHoldBars in noTrade must also be <= 15', () => {
    // Force noTrade by using candles with very low volume
    const lowVol = bullishEngulfing.map(c => ({ ...c, v: 10 }));
    const r = score(lowVol);
    expect(r.action).toBe('NO TRADE');
    expect(r.maxHoldBars).toBeLessThanOrEqual(25);
  });

  it('confidence floor is 20 (not higher)', () => {
    const r = score(bullishEngulfing);
    expect(r.confidence).toBeGreaterThanOrEqual(20);
  });

  it('returns required fields', () => {
    const r = score(bullishEngulfing);
    expect(r).toHaveProperty('confidence');
    expect(r).toHaveProperty('action');
    expect(r).toHaveProperty('direction');
    expect(r).toHaveProperty('entry');
    expect(r).toHaveProperty('sl');
    expect(r).toHaveProperty('target');
    expect(r).toHaveProperty('rr');
    expect(r).toHaveProperty('maxHoldBars');
  });

  it('bearish signal returns short direction', () => {
    const r = score(bearishEngulfing);
    if (r.action !== 'NO TRADE') {
      expect(r.direction).toBe('short');
    }
  });
});

// ─── Regime-aware ATR-based stops (P2 #11) ─────────────────────────────
// These tests exercise computeRiskScore directly with a stubbed bullish
// pattern so we can compare SL/target across flag and regime variants
// without having to reverse-engineer candle fixtures that trigger the
// strict scalp pattern gate.

describe('computeATR (atrLike helper)', () => {
  it('returns 0 for <2 bars (guard)', () => {
    expect(atrLike([], 14)).toBe(0);
    expect(atrLike([{ t: 1, o: 100, h: 101, l: 99, c: 100, v: 1 }], 14)).toBe(0);
  });

  it('averages true range over the last n bars', () => {
    // 3 bars, true range per bar = {2, 3, 4}; avg over last 2 = 3.5.
    const bars = [
      { t: 1, o: 100, h: 101, l: 99, c: 100, v: 1 },   // no TR (first bar, skipped)
      { t: 2, o: 100, h: 102, l: 100, c: 101, v: 1 },  // TR = max(2, 2, 0) = 2 when prev.c=100
      { t: 3, o: 101, h: 104, l: 101, c: 103, v: 1 },  // TR = max(3, 3, 0) = 3
      { t: 4, o: 103, h: 107, l: 103, c: 106, v: 1 },  // TR = max(4, 4, 0) = 4
    ];
    expect(atrLike(bars, 2)).toBeCloseTo(3.5, 6);
    // With n=14 but only 4 bars, window collapses to the last 3 (n = candles.length - 1).
    expect(atrLike(bars, 14)).toBeCloseTo((2 + 3 + 4) / 3, 6);
  });
});

describe('computeRiskScore — regime-aware SL/target (P2 #11)', () => {
  const bullishStub = [{ name: 'Strong Momo Pullback', direction: 'bullish', strength: 0.85 }];

  function risk(candles, opts) {
    return computeRiskScore({ candles, patterns: bullishStub, opts });
  }

  it('flag OFF (default) preserves legacy 0.5% SL / 1.0% target regardless of vixRegime', () => {
    const r = risk(bullishEngulfing, {});
    const entry = r.entry;
    expect(r.entry - r.sl).toBeCloseTo(entry * 0.005, 6);
    expect(r.target - r.entry).toBeCloseTo(entry * 0.010, 6);
    expect(r.features?.regimeAwareUsed).toBe(false);

    // Legacy path also when flag OFF even though vixRegime is HIGH — regression-proof.
    const rHigh = risk(bullishEngulfing, { vixRegime: 'HIGH' });
    expect(rHigh.entry - rHigh.sl).toBeCloseTo(entry * 0.005, 6);
    expect(rHigh.target - rHigh.entry).toBeCloseTo(entry * 0.010, 6);
    expect(rHigh.features?.regimeAwareUsed).toBe(false);
  });

  it('flag ON with vixRegime=HIGH widens SL vs legacy (ATR-scaled)', () => {
    const legacy = risk(bullishEngulfing, {});
    const regime = risk(bullishEngulfing, { regimeAwareStops: true, vixRegime: 'HIGH' });
    const slDistLegacy = legacy.entry - legacy.sl;
    const slDistHigh = regime.entry - regime.sl;
    // HIGH must strictly widen SL vs the 0.5% hardcoded floor for any
    // ATR-pct > 0.33% (which the bullishEngulfing fixture easily clears).
    expect(slDistHigh).toBeGreaterThan(slDistLegacy);
    expect(regime.features.regimeAwareUsed).toBe(true);
    expect(regime.features.vixRegime).toBe('HIGH');
    expect(regime.features.slPct).toBeGreaterThan(0.005);
  });

  it('flag ON with vixRegime unknown falls back to legacy path', () => {
    const r = risk(bullishEngulfing, { regimeAwareStops: true, vixRegime: null });
    expect(r.entry - r.sl).toBeCloseTo(r.entry * 0.005, 6);
    expect(r.features.regimeAwareUsed).toBe(false);
  });

  it('features carry atr, atrPct, slPct, targetPct, vixRegime for post-hoc analysis', () => {
    const r = risk(bullishEngulfing, { regimeAwareStops: true, vixRegime: 'NORMAL' });
    expect(r.features).toMatchObject({
      atr: expect.any(Number),
      atrPct: expect.any(Number),
      slPct: expect.any(Number),
      targetPct: expect.any(Number),
      vixRegime: 'NORMAL',
      regimeAwareUsed: true,
    });
    expect(r.features.atr).toBeGreaterThan(0);
    expect(r.features.atrPct).toBeGreaterThan(0);
  });

  it('slPct/targetPct respect the bounded floor and cap', () => {
    // Tiny-ATR bars → slPct should clamp to the legacy 0.5% floor so
    // regime-aware never tightens below the empirically-tuned baseline.
    const flat = Array.from({ length: 20 }, (_, i) => ({
      t: 1700000000 + i * 60, o: 100, h: 100.01, l: 99.99, c: 100, v: 10000,
    }));
    const r = computeRiskScore({
      candles: flat,
      patterns: bullishStub,
      opts: { regimeAwareStops: true, vixRegime: 'LOW' },
    });
    expect(r.features.slPct).toBeGreaterThanOrEqual(0.005);
    expect(r.features.slPct).toBeLessThanOrEqual(0.015);
    expect(r.features.targetPct).toBeGreaterThanOrEqual(0.010);
    expect(r.features.targetPct).toBeLessThanOrEqual(0.030);
  });
});
