import { describe, it, expect } from 'vitest';
import {
  SIGNAL_CATEGORIES, APPROX_PATTERN_RULES,
  normalizeEngine, ENGINE_LIST,
  getCategoriesForEngine, getCategoriesUIForEngine, getRuleCountForEngine,
} from './signalCategories.js';

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

describe('normalizeEngine', () => {
  it('returns canonical names unchanged', () => {
    expect(normalizeEngine('scalp')).toBe('scalp');
    expect(normalizeEngine('intraday')).toBe('intraday');
    expect(normalizeEngine('delivery')).toBe('delivery');
  });

  it('maps legacy v2 → intraday', () => {
    expect(normalizeEngine('v2')).toBe('intraday');
  });

  it('maps legacy v1 and classic → delivery', () => {
    expect(normalizeEngine('v1')).toBe('delivery');
    expect(normalizeEngine('classic')).toBe('delivery');
  });

  it('falls back to scalp for unknown / null / undefined', () => {
    expect(normalizeEngine(null)).toBe('scalp');
    expect(normalizeEngine(undefined)).toBe('scalp');
    expect(normalizeEngine('')).toBe('scalp');
    expect(normalizeEngine('garbage')).toBe('scalp');
  });

  it('exposes ENGINE_LIST in canonical order', () => {
    expect(ENGINE_LIST).toEqual(['scalp', 'intraday', 'delivery']);
  });
});

describe('engine-aware resolvers accept canonical + legacy', () => {
  it('getCategoriesForEngine returns same set for v1 and delivery', () => {
    expect(getCategoriesForEngine('delivery')).toEqual(getCategoriesForEngine('v1'));
  });
  it('getCategoriesForEngine returns same set for v2 and intraday', () => {
    expect(getCategoriesForEngine('intraday')).toEqual(getCategoriesForEngine('v2'));
  });
  it('getCategoriesUIForEngine returns same set for v1 and delivery', () => {
    expect(getCategoriesUIForEngine('delivery')).toEqual(getCategoriesUIForEngine('v1'));
  });
  it('getRuleCountForEngine returns same count for v2 and intraday', () => {
    expect(getRuleCountForEngine('intraday')).toBe(getRuleCountForEngine('v2'));
  });
});
