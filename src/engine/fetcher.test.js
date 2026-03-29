import { describe, it, expect } from 'vitest';
import { trimTrailingFlatCandles, TIMEFRAME_MAP, _normalizeSymbol, _parseChartJson } from './fetcher.js';
import { withTrailingFlats, yahooChartJson } from './__fixtures__/candles.js';

describe('trimTrailingFlatCandles', () => {
  it('removes trailing flat candles', () => {
    const result = trimTrailingFlatCandles(withTrailingFlats);
    expect(result.length).toBe(6);
    const last = result[result.length - 1];
    expect(last.h - last.l).toBeGreaterThan(0);
  });

  it('does not remove non-flat trailing candles', () => {
    const candles = withTrailingFlats.slice(0, 6);
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
    const allFlat = Array.from({ length: 10 }, (_, i) => ({
      t: i, o: 100, h: i < 5 ? 102 : 100, l: i < 5 ? 99 : 100, c: 100, v: 0,
    }));
    const result = trimTrailingFlatCandles(allFlat);
    expect(result.length).toBeGreaterThanOrEqual(5);
  });

  it('does not mutate original array', () => {
    const original = [...withTrailingFlats];
    trimTrailingFlatCandles(withTrailingFlats);
    expect(withTrailingFlats.length).toBe(original.length);
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

describe('normalizeSymbol', () => {
  it('adds .NS suffix to plain symbols', () => {
    expect(_normalizeSymbol('RELIANCE')).toBe('RELIANCE.NS');
    expect(_normalizeSymbol('TCS')).toBe('TCS.NS');
  });

  it('strips existing .NS and re-adds', () => {
    expect(_normalizeSymbol('RELIANCE.NS')).toBe('RELIANCE.NS');
  });

  it('uppercases input', () => {
    expect(_normalizeSymbol('reliance')).toBe('RELIANCE.NS');
  });

  it('trims whitespace', () => {
    expect(_normalizeSymbol('  TCS  ')).toBe('TCS.NS');
  });

  it('maps NIFTY50 to ^NSEI', () => {
    expect(_normalizeSymbol('NIFTY50')).toBe('^NSEI');
    expect(_normalizeSymbol('NIFTY')).toBe('^NSEI');
  });

  it('maps BANKNIFTY to ^NSEBANK', () => {
    expect(_normalizeSymbol('BANKNIFTY')).toBe('^NSEBANK');
  });

  it('preserves ^ prefix symbols', () => {
    expect(_normalizeSymbol('^NSEI')).toBe('^NSEI');
    expect(_normalizeSymbol('^NSEBANK')).toBe('^NSEBANK');
  });

  it('handles empty/null input', () => {
    expect(_normalizeSymbol('')).toBe('.NS');
    expect(_normalizeSymbol(null)).toBe('.NS');
    expect(_normalizeSymbol(undefined)).toBe('.NS');
  });
});

describe('parseChartJson', () => {
  it('parses valid Yahoo chart JSON', () => {
    const result = _parseChartJson(yahooChartJson);
    expect(result).not.toBeNull();
    expect(result.candles).toHaveLength(3);
    expect(result.companyName).toBe('Reliance Industries');
  });

  it('candle has correct OHLCV fields', () => {
    const result = _parseChartJson(yahooChartJson);
    const c = result.candles[0];
    expect(c).toHaveProperty('t');
    expect(c).toHaveProperty('o');
    expect(c).toHaveProperty('h');
    expect(c).toHaveProperty('l');
    expect(c).toHaveProperty('c');
    expect(c).toHaveProperty('v');
    expect(c.o).toBe(100);
    expect(c.h).toBe(102);
    expect(c.l).toBe(99);
    expect(c.c).toBe(101);
    expect(c.v).toBe(100000);
  });

  it('skips candles with null OHLC values', () => {
    const json = {
      chart: {
        result: [{
          meta: {},
          timestamp: [1, 2, 3],
          indicators: {
            quote: [{
              open: [100, null, 102],
              high: [102, null, 104],
              low: [99, null, 101],
              close: [101, null, 103],
              volume: [1000, 0, 1000],
            }],
          },
        }],
      },
    };
    const result = _parseChartJson(json);
    expect(result.candles).toHaveLength(2);
  });

  it('returns null for missing result', () => {
    expect(_parseChartJson(null)).toBeNull();
    expect(_parseChartJson({})).toBeNull();
    expect(_parseChartJson({ chart: {} })).toBeNull();
    expect(_parseChartJson({ chart: { result: [] } })).toBeNull();
  });

  it('returns null for missing timestamps', () => {
    const json = { chart: { result: [{ meta: {}, indicators: { quote: [{}] } }] } };
    expect(_parseChartJson(json)).toBeNull();
  });

  it('defaults volume to 0 when null', () => {
    const json = {
      chart: {
        result: [{
          meta: {},
          timestamp: [1],
          indicators: {
            quote: [{
              open: [100], high: [102], low: [99], close: [101],
              volume: [null],
            }],
          },
        }],
      },
    };
    const result = _parseChartJson(json);
    expect(result.candles[0].v).toBe(0);
  });

  it('extracts companyName from meta', () => {
    const json = {
      chart: {
        result: [{
          meta: { shortName: 'TCS Ltd' },
          timestamp: [1],
          indicators: { quote: [{ open: [100], high: [101], low: [99], close: [100], volume: [100] }] },
        }],
      },
    };
    expect(_parseChartJson(json).companyName).toBe('TCS Ltd');
  });
});
