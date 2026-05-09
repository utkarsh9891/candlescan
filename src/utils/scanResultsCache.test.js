import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  saveScanResults,
  loadScanResults,
  clearScanResults,
  __test,
} from './scanResultsCache.js';

const store = {};
const localStorageMock = {
  getItem: vi.fn((key) => (key in store ? store[key] : null)),
  setItem: vi.fn((key, val) => { store[key] = val; }),
  removeItem: vi.fn((key) => { delete store[key]; }),
  clear: vi.fn(() => { for (const k of Object.keys(store)) delete store[k]; }),
};

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  vi.stubGlobal('localStorage', localStorageMock);
  localStorageMock.getItem.mockClear();
  localStorageMock.setItem.mockClear();
  localStorageMock.removeItem.mockClear();
});

const sampleKey = {
  engine: 'scalp', index: 'NIFTY 100', timeframe: '1m', dataSource: 'yahoo',
};

const sampleResults = [
  {
    symbol: 'TCS',
    companyName: 'Tata Consultancy',
    action: 'STRONG BUY',
    confidence: 82,
    direction: 'long',
    entry: 4123.5, sl: 4080, target: 4200, rr: 1.8,
    topPattern: 'Strong Momo Pullback',
    signalBarTs: 1730000000,
    validTillTs: 1730001200,
    sector: 'IT',
    vixRegime: 'NORMAL',
    newsSentiment: 'BULLISH',
    newsScore: 0.42,
    newsHeadlines: Array.from({ length: 8 }, (_, i) => ({
      title: `Headline ${i}`, score: 0.5, url: `https://x/${i}`, publisher: 'pub',
    })),
    proximityInfo: { direction: 'long', hint: 'fired' },
    rawOHLCV: 'should be dropped',
  },
];

describe('scanResultsCache.buildKey', () => {
  it('produces stable, sanitized keys', () => {
    const k1 = __test.buildKey(sampleKey);
    expect(k1).toMatch(/^cs\.scanCache\.v1\./);
    expect(k1).toContain('scalp');
    expect(k1).toContain('NIFTY_100');
    expect(k1).toContain('1m');
    expect(k1).toContain('yahoo');
  });

  it('handles missing components gracefully', () => {
    const k = __test.buildKey({});
    expect(k).toBe('cs.scanCache.v1.na.na.na.na');
  });

  it('escapes characters that would break the key', () => {
    const k = __test.buildKey({
      engine: 'scalp', index: 'A&B/C', timeframe: '1m', dataSource: 'yahoo',
    });
    expect(k).not.toContain('&');
    expect(k).not.toContain('/');
  });
});

describe('scanResultsCache.trimResult', () => {
  it('drops heavy fields and caps headlines', () => {
    const t = __test.trimResult(sampleResults[0]);
    expect(t.symbol).toBe('TCS');
    expect(t.rawOHLCV).toBeUndefined();
    expect(t.newsHeadlines).toHaveLength(5);
    expect(t.newsHeadlines[0]).toEqual({
      title: 'Headline 0', score: 0.5, url: 'https://x/0', publisher: 'pub',
    });
  });

  it('returns null for non-objects', () => {
    expect(__test.trimResult(null)).toBeNull();
    expect(__test.trimResult('x')).toBeNull();
  });
});

describe('saveScanResults', () => {
  it('persists trimmed results and returns true', () => {
    const ok = saveScanResults({
      ...sampleKey,
      results: sampleResults,
      telemetry: { totalMs: 1234, symbolsScanned: 50 },
      savedAt: 1_700_000_000_000,
    });
    expect(ok).toBe(true);
    const stored = JSON.parse(store[__test.buildKey(sampleKey)]);
    expect(stored.savedAt).toBe(1_700_000_000_000);
    expect(stored.results[0].symbol).toBe('TCS');
    expect(stored.results[0].rawOHLCV).toBeUndefined();
    expect(stored.telemetry.totalMs).toBe(1234);
  });

  it('refuses to save empty results', () => {
    const ok = saveScanResults({ ...sampleKey, results: [] });
    expect(ok).toBe(false);
    expect(localStorageMock.setItem).not.toHaveBeenCalled();
  });

  it('swallows quota errors silently', () => {
    const big = { ...sampleKey, results: sampleResults };
    localStorageMock.setItem.mockImplementationOnce(() => { throw new Error('QuotaExceeded'); });
    const ok = saveScanResults(big);
    expect(ok).toBe(false);
  });
});

describe('loadScanResults', () => {
  it('round-trips a saved scan', () => {
    saveScanResults({
      ...sampleKey,
      results: sampleResults,
      telemetry: { x: 1 },
      savedAt: 1_700_000_000_000,
    });
    const loaded = loadScanResults({ ...sampleKey, now: 1_700_000_000_000 + 1000 });
    expect(loaded).not.toBeNull();
    expect(loaded.results[0].symbol).toBe('TCS');
    expect(loaded.telemetry.x).toBe(1);
  });

  it('returns null on miss', () => {
    expect(loadScanResults(sampleKey)).toBeNull();
  });

  it('drops entries older than 4 hours', () => {
    const savedAt = 1_700_000_000_000;
    saveScanResults({ ...sampleKey, results: sampleResults, savedAt });
    const FOUR_H_PLUS = 4 * 60 * 60 * 1000 + 1;
    const loaded = loadScanResults({ ...sampleKey, now: savedAt + FOUR_H_PLUS });
    expect(loaded).toBeNull();
    // Stale entry is eagerly cleared.
    expect(localStorageMock.removeItem).toHaveBeenCalled();
  });

  it('keeps entries that are exactly within 4 hours', () => {
    const savedAt = 1_700_000_000_000;
    saveScanResults({ ...sampleKey, results: sampleResults, savedAt });
    const FOUR_H = 4 * 60 * 60 * 1000;
    const loaded = loadScanResults({ ...sampleKey, now: savedAt + FOUR_H });
    expect(loaded).not.toBeNull();
  });

  it('returns null and removes the entry on JSON parse failure', () => {
    const key = __test.buildKey(sampleKey);
    store[key] = '{not valid json';
    const loaded = loadScanResults(sampleKey);
    expect(loaded).toBeNull();
    expect(localStorageMock.removeItem).toHaveBeenCalledWith(key);
  });

  it('returns null and removes the entry on schema mismatch', () => {
    const key = __test.buildKey(sampleKey);
    store[key] = JSON.stringify({ savedAt: Date.now(), results: 'not an array' });
    expect(loadScanResults(sampleKey)).toBeNull();
    expect(localStorageMock.removeItem).toHaveBeenCalledWith(key);
  });

  it('does not return entries from a different cache key', () => {
    saveScanResults({ ...sampleKey, results: sampleResults });
    const loaded = loadScanResults({ ...sampleKey, engine: 'intraday' });
    expect(loaded).toBeNull();
  });
});

describe('clearScanResults', () => {
  it('removes the cached entry', () => {
    saveScanResults({ ...sampleKey, results: sampleResults });
    clearScanResults(sampleKey);
    expect(localStorageMock.removeItem).toHaveBeenCalledWith(__test.buildKey(sampleKey));
    expect(loadScanResults(sampleKey)).toBeNull();
  });
});
