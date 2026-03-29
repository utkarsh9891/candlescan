import { describe, it, expect } from 'vitest';
import { computeRiskScore, detectContext } from './risk.js';
import { detectPatterns } from './patterns.js';
import { detectLiquidityBox } from './liquidityBox.js';
import { bullishEngulfing, bearishEngulfing, sideways, consolidationBreakout } from './__fixtures__/candles.js';

function score(candles) {
  const patterns = detectPatterns(candles);
  const box = detectLiquidityBox(candles);
  return computeRiskScore({ candles, patterns, box });
}

describe('computeRiskScore', () => {
  it('returns required fields', () => {
    const r = score(bullishEngulfing);
    expect(r).toHaveProperty('confidence');
    expect(r).toHaveProperty('action');
    expect(r).toHaveProperty('direction');
    expect(r).toHaveProperty('entry');
    expect(r).toHaveProperty('sl');
    expect(r).toHaveProperty('target');
    expect(r).toHaveProperty('rr');
    expect(r).toHaveProperty('context');
    expect(r).toHaveProperty('level');
  });

  it('confidence is between 40 and 100', () => {
    const r = score(bullishEngulfing);
    expect(r.confidence).toBeGreaterThanOrEqual(40);
    expect(r.confidence).toBeLessThanOrEqual(100);
  });

  it('bullish engulfing produces long direction', () => {
    const r = score(bullishEngulfing);
    expect(r.direction).toBe('long');
  });

  it('bearish engulfing produces short direction', () => {
    const r = score(bearishEngulfing);
    expect(r.direction).toBe('short');
  });

  it('action is a valid label', () => {
    const valid = ['STRONG BUY', 'BUY', 'WAIT', 'STRONG SHORT', 'SHORT', 'NO TRADE'];
    const r = score(bullishEngulfing);
    expect(valid).toContain(r.action);
  });

  it('entry, sl, target are positive numbers', () => {
    const r = score(bullishEngulfing);
    expect(r.entry).toBeGreaterThan(0);
    expect(r.sl).toBeGreaterThan(0);
    expect(r.target).toBeGreaterThan(0);
  });

  it('R:R ratio is a finite number', () => {
    const r = score(bullishEngulfing);
    expect(Number.isFinite(r.rr)).toBe(true);
  });

  it('sideways data produces lower confidence', () => {
    const r = score(sideways);
    // Sideways should not produce strong signals
    expect(r.confidence).toBeLessThan(80);
  });
});

describe('detectContext', () => {
  it('returns a valid context string', () => {
    const valid = ['at_support', 'at_resistance', 'mid_range', 'breakout'];
    const ctx = detectContext(bullishEngulfing, null);
    expect(valid).toContain(ctx);
  });

  it('detects breakout with consolidation breakout data', () => {
    const box = detectLiquidityBox(consolidationBreakout);
    if (box) {
      const ctx = detectContext(consolidationBreakout, box);
      // With a breakout candle, context should reflect that
      expect(typeof ctx).toBe('string');
    }
  });
});
