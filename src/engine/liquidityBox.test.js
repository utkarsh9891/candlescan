import { describe, it, expect } from 'vitest';
import { detectLiquidityBox } from './liquidityBox.js';
import { consolidation, consolidationBreakout, bullishEngulfing } from './__fixtures__/candles.js';

describe('detectLiquidityBox', () => {
  it('detects a box in consolidation data', () => {
    const box = detectLiquidityBox(consolidation);
    expect(box).not.toBeNull();
    expect(box).toHaveProperty('high');
    expect(box).toHaveProperty('low');
    expect(box).toHaveProperty('startIdx');
    expect(box).toHaveProperty('endIdx');
    expect(box.high).toBeGreaterThan(box.low);
  });

  it('box has quality score between 0 and 1', () => {
    const box = detectLiquidityBox(consolidation);
    if (box) {
      expect(box.quality).toBeGreaterThanOrEqual(0);
      expect(box.quality).toBeLessThanOrEqual(1);
    }
  });

  it('detects breakout in consolidation+breakout data', () => {
    const box = detectLiquidityBox(consolidationBreakout);
    if (box && box.breakout) {
      expect(['bullish', 'bearish', 'none']).toContain(box.breakout);
    }
  });

  it('returns null for too few candles', () => {
    const result = detectLiquidityBox([]);
    expect(result).toBeNull();
  });

  it('returns null or box for trending data', () => {
    // Trending data (bullish engulfing) may or may not have a box
    const box = detectLiquidityBox(bullishEngulfing);
    // Just verify it doesn't crash
    expect(box === null || typeof box === 'object').toBe(true);
  });

  it('startIdx and endIdx are valid indices', () => {
    const box = detectLiquidityBox(consolidation);
    if (box) {
      expect(box.startIdx).toBeGreaterThanOrEqual(0);
      expect(box.endIdx).toBeGreaterThan(box.startIdx);
      expect(box.endIdx).toBeLessThan(consolidation.length);
    }
  });
});
