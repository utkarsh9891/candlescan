import { describe, it, expect } from 'vitest';
import { SIGNAL_CATEGORIES, APPROX_PATTERN_RULES } from './signalCategories.js';

describe('SIGNAL_CATEGORIES', () => {
  it('has 8 categories', () => {
    expect(SIGNAL_CATEGORIES).toHaveLength(8);
  });

  it('contains expected categories', () => {
    const expected = ['engulfing', 'piercing', 'hammer', 'reversal', 'pullback', 'liquidity', 'momentum', 'indecision'];
    expect(SIGNAL_CATEGORIES).toEqual(expected);
  });

  it('all entries are strings', () => {
    for (const cat of SIGNAL_CATEGORIES) {
      expect(typeof cat).toBe('string');
    }
  });

  it('has no duplicates', () => {
    expect(new Set(SIGNAL_CATEGORIES).size).toBe(SIGNAL_CATEGORIES.length);
  });
});

describe('APPROX_PATTERN_RULES', () => {
  it('is a positive number', () => {
    expect(typeof APPROX_PATTERN_RULES).toBe('number');
    expect(APPROX_PATTERN_RULES).toBeGreaterThan(0);
  });
});
