import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trimTrailingFlatCandles, TIMEFRAME_MAP, _normalizeSymbol, _parseChartJson, fetchOHLCV, generateSimulatedCandles } from './fetcher.js';
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

describe('fetchOHLCV (with mocked fetch)', () => {
  const mockFetch = vi.fn();
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    mockFetch.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns candles on successful fetch', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => yahooChartJson,
      text: async () => JSON.stringify(yahooChartJson),
    });

    const result = await fetchOHLCV('RELIANCE', '5m');
    expect(result.candles.length).toBeGreaterThan(0);
    expect(result.live).toBe(true);
    expect(result.simulated).toBe(false);
    expect(result.yahooSymbol).toBe('RELIANCE.NS');
    expect(result.displaySymbol).toBe('RELIANCE');
    expect(result.companyName).toBe('Reliance Industries');
  });

  it('returns error when all fetches fail', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));

    const result = await fetchOHLCV('RELIANCE', '5m');
    expect(result.candles).toEqual([]);
    expect(result.error).toBeTruthy();
    expect(result.live).toBe(false);
  });

  it('normalizes display symbol to uppercase', async () => {
    mockFetch.mockRejectedValue(new Error('fail'));
    const result = await fetchOHLCV('reliance', '5m');
    expect(result.displaySymbol).toBe('RELIANCE');
    expect(result.yahooSymbol).toBe('RELIANCE.NS');
  });

  it('uses default timeframe when invalid key given', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => yahooChartJson,
    });

    const result = await fetchOHLCV('TCS', 'invalid_tf');
    expect(result.candles.length).toBeGreaterThan(0);
    // Should still work using default 5m timeframe
  });

  it('tries fallback after first proxy fails', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('proxy down');
      return { ok: true, json: async () => yahooChartJson };
    });

    const result = await fetchOHLCV('INFY', '5m');
    expect(result.candles.length).toBeGreaterThan(0);
    expect(callCount).toBeGreaterThan(1); // fell through to fallback
  });

  it('handles fetch returning non-ok status', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429 });

    const result = await fetchOHLCV('SBIN', '5m');
    expect(result.candles).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it('handles fetch returning invalid JSON structure', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ invalid: 'structure' }),
    });

    const result = await fetchOHLCV('TCS', '5m');
    expect(result.candles).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it('trims trailing flat candles from results', async () => {
    const jsonWithFlats = {
      chart: {
        result: [{
          meta: { longName: 'Test' },
          timestamp: [1, 2, 3, 4, 5, 6, 7, 8],
          indicators: {
            quote: [{
              open:   [100, 101, 102, 103, 104, 105, 105.5, 105.5],
              high:   [102, 103, 104, 105, 106, 106, 105.5, 105.5],
              low:    [99,  100, 101, 102, 103, 104, 105.5, 105.5],
              close:  [101, 102, 103, 104, 105, 105.5, 105.5, 105.5],
              volume: [1e5, 1e5, 1e5, 1e5, 1e5, 1e5, 0, 0],
            }],
          },
        }],
      },
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => jsonWithFlats,
    });

    const result = await fetchOHLCV('TEST', '5m');
    // Should trim the 2 flat trailing candles
    expect(result.candles.length).toBe(6);
  });
});

describe('generateSimulatedCandles', () => {
  it('generates the requested number of candles', () => {
    const candles = generateSimulatedCandles('RELIANCE', 50);
    expect(candles.length).toBe(50);
  });

  it('each candle has OHLCV fields', () => {
    const candles = generateSimulatedCandles('TCS', 10);
    for (const c of candles) {
      expect(c).toHaveProperty('t');
      expect(c).toHaveProperty('o');
      expect(c).toHaveProperty('h');
      expect(c).toHaveProperty('l');
      expect(c).toHaveProperty('c');
      expect(c).toHaveProperty('v');
      expect(c.h).toBeGreaterThanOrEqual(c.l);
    }
  });

  it('is deterministic for the same symbol', () => {
    const a = generateSimulatedCandles('RELIANCE', 20);
    const b = generateSimulatedCandles('RELIANCE', 20);
    expect(a).toEqual(b);
  });

  it('produces different data for different symbols', () => {
    const a = generateSimulatedCandles('RELIANCE', 20);
    const b = generateSimulatedCandles('TCS', 20);
    expect(a[0].o).not.toBe(b[0].o);
  });

  it('defaults to 80 candles', () => {
    const candles = generateSimulatedCandles('X');
    expect(candles.length).toBe(80);
  });
});
