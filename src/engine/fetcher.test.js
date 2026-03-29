import { describe, it, expect } from 'vitest';
import { trimTrailingFlatCandles, TIMEFRAME_MAP } from './fetcher.js';
import { withTrailingFlats } from './__fixtures__/candles.js';

describe('trimTrailingFlatCandles', () => {
  it('removes trailing flat candles', () => {
    const result = trimTrailingFlatCandles(withTrailingFlats);
    expect(result.length).toBe(6); // 8 total - 2 flat = 6
    // Last candle should have non-zero range
    const last = result[result.length - 1];
    expect(last.h - last.l).toBeGreaterThan(0);
  });

  it('does not remove non-flat trailing candles', () => {
    const candles = withTrailingFlats.slice(0, 6); // no flat candles
    const result = trimTrailingFlatCandles(candles);
    expect(result.length).toBe(6);
  });

  it('handles empty array', () => {
    expect(trimTrailingFlatCandles([])).toEqual([]);
  });

  it('handles null/undefined', () => {
    expect(trimTrailingFlatCandles(null)).toBeNull();
    expect(trimTrailingFlatCandles(undefined)).toBeUndefined();
  });

  it('preserves at least 5 candles', () => {
    // All flat except first 5
    const allFlat = Array.from({ length: 10 }, (_, i) => ({
      t: i, o: 100, h: i < 5 ? 102 : 100, l: i < 5 ? 99 : 100, c: 100, v: 0,
    }));
    const result = trimTrailingFlatCandles(allFlat);
    expect(result.length).toBeGreaterThanOrEqual(5);
  });
});

describe('TIMEFRAME_MAP', () => {
  it('has all 6 timeframes', () => {
    expect(Object.keys(TIMEFRAME_MAP)).toEqual(['1m', '5m', '15m', '30m', '1h', '1d']);
  });

  it('each timeframe has interval and range', () => {
    for (const tf of Object.values(TIMEFRAME_MAP)) {
      expect(tf).toHaveProperty('interval');
      expect(tf).toHaveProperty('range');
    }
  });
});
