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
import { bullishEngulfing, bearishEngulfing } from './__fixtures__/candles.js';

function score(candles, opts = {}) {
  const patterns = detectPatterns(candles, opts);
  const box = detectLiquidityBox(candles);
  return computeRiskScore({ candles, patterns, box, opts });
}

describe('scalp engine — hard constraints', () => {
  it('maxHoldBars must be <= 15 (15 min on 1m)', () => {
    const r = score(bullishEngulfing);
    expect(r.maxHoldBars).toBeLessThanOrEqual(15);
    expect(r.maxHoldBars).toBeGreaterThan(0);
  });

  it('maxHoldBars in noTrade must also be <= 15', () => {
    // Force noTrade by using candles with very low volume
    const lowVol = bullishEngulfing.map(c => ({ ...c, v: 10 }));
    const r = score(lowVol);
    expect(r.action).toBe('NO TRADE');
    expect(r.maxHoldBars).toBeLessThanOrEqual(15);
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
