import { describe, it, expect } from 'vitest';
import { detectPatterns } from './patterns.js';
import { bullishEngulfing, bearishEngulfing, hammerPattern, sideways } from './__fixtures__/candles.js';

describe('detectPatterns', () => {
  it('returns an array', () => {
    const result = detectPatterns(bullishEngulfing);
    expect(Array.isArray(result)).toBe(true);
  });

  it('detects bullish patterns in bullish engulfing setup', () => {
    const patterns = detectPatterns(bullishEngulfing);
    expect(patterns.length).toBeGreaterThan(0);
    const bullish = patterns.filter((p) => p.direction === 'bullish');
    expect(bullish.length).toBeGreaterThan(0);
  });

  it('detects bearish patterns in bearish engulfing setup', () => {
    const patterns = detectPatterns(bearishEngulfing);
    expect(patterns.length).toBeGreaterThan(0);
    const bearish = patterns.filter((p) => p.direction === 'bearish');
    expect(bearish.length).toBeGreaterThan(0);
  });

  it('detects patterns in hammer setup', () => {
    const patterns = detectPatterns(hammerPattern);
    expect(patterns.length).toBeGreaterThan(0);
  });

  it('each pattern has required fields', () => {
    const patterns = detectPatterns(bullishEngulfing);
    for (const p of patterns) {
      expect(p).toHaveProperty('name');
      expect(p).toHaveProperty('direction');
      expect(p).toHaveProperty('strength');
      expect(p).toHaveProperty('category');
      expect(p).toHaveProperty('reliability');
      expect(typeof p.strength).toBe('number');
      expect(p.strength).toBeGreaterThanOrEqual(0);
      expect(p.strength).toBeLessThanOrEqual(1);
    }
  });

  it('patterns are sorted by strength descending', () => {
    const patterns = detectPatterns(bullishEngulfing);
    for (let i = 1; i < patterns.length; i++) {
      expect(patterns[i].strength).toBeLessThanOrEqual(patterns[i - 1].strength);
    }
  });

  it('returns empty array for insufficient candles', () => {
    expect(detectPatterns([])).toEqual([]);
    expect(detectPatterns([{ o: 100, h: 101, l: 99, c: 100, v: 1000 }])).toEqual([]);
  });

  it('handles sideways data without crashing', () => {
    const patterns = detectPatterns(sideways);
    expect(Array.isArray(patterns)).toBe(true);
  });
});
