import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getCachedChart,
  setCachedChart,
  clearChartCache,
  _internals,
} from './chartCacheLocal.js';

function mkCandles(n, start = 100) {
  return Array.from({ length: n }, (_, i) => ({
    t: 1_700_000_000 + i * 60,
    o: start + i,
    h: start + i + 1,
    l: start + i - 1,
    c: start + i + 0.5,
    v: 10_000 + i,
  }));
}

describe('chartCacheLocal hit/miss', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns null on miss', () => {
    expect(getCachedChart('yahoo', 'RELIANCE', '5m', '2026-04-10')).toBeNull();
  });

  it('round-trips a payload through set + get', () => {
    const candles = mkCandles(5);
    setCachedChart('yahoo', 'RELIANCE', '5m', '2026-04-10', candles);
    const hit = getCachedChart('yahoo', 'RELIANCE', '5m', '2026-04-10');
    expect(hit).not.toBeNull();
    expect(hit.candles).toEqual(candles);
    expect(typeof hit.fetchedAt).toBe('number');
  });

  it('writes a sibling :meta entry with size + fetchedAt + expiresAt', () => {
    setCachedChart('dhan', 'TCS', '1m', '2026-04-10', mkCandles(3));
    const metaRaw = localStorage.getItem(
      _internals.buildKey('dhan', 'TCS', '1m', '2026-04-10') + _internals.META_SUFFIX
    );
    const meta = JSON.parse(metaRaw);
    expect(meta).toHaveProperty('size');
    expect(meta).toHaveProperty('fetchedAt');
    expect(meta).toHaveProperty('expiresAt');
    expect(meta.expiresAt).toBeGreaterThan(meta.fetchedAt);
  });

  it('normalizes symbol (uppercase + strip .NS)', () => {
    setCachedChart('yahoo', 'reliance.NS', '5m', '2026-04-10', mkCandles(2));
    const hit = getCachedChart('yahoo', 'RELIANCE', '5m', '2026-04-10');
    expect(hit).not.toBeNull();
    expect(hit.candles.length).toBe(2);
  });

  it('separate (source, interval, date) tuples do not collide', () => {
    setCachedChart('yahoo', 'X', '1m', '2026-04-10', mkCandles(1));
    setCachedChart('yahoo', 'X', '5m', '2026-04-10', mkCandles(2));
    setCachedChart('yahoo', 'X', '1m', '2026-04-09', mkCandles(3));
    setCachedChart('dhan', 'X', '1m', '2026-04-10', mkCandles(4));
    expect(getCachedChart('yahoo', 'X', '1m', '2026-04-10').candles.length).toBe(1);
    expect(getCachedChart('yahoo', 'X', '5m', '2026-04-10').candles.length).toBe(2);
    expect(getCachedChart('yahoo', 'X', '1m', '2026-04-09').candles.length).toBe(3);
    expect(getCachedChart('dhan', 'X', '1m', '2026-04-10').candles.length).toBe(4);
  });

  it('does not cache empty / non-array payloads', () => {
    setCachedChart('yahoo', 'X', '1m', '2026-04-10', []);
    setCachedChart('yahoo', 'X', '1m', '2026-04-10', null);
    setCachedChart('yahoo', 'X', '1m', '2026-04-10', undefined);
    expect(getCachedChart('yahoo', 'X', '1m', '2026-04-10')).toBeNull();
  });
});

describe('chartCacheLocal TTL expiry', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null after ttlMs elapses and evicts both keys', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T10:00:00Z'));
    setCachedChart('yahoo', 'HDFC', '5m', '2026-04-10', mkCandles(4), { ttlMs: 60_000 });
    expect(getCachedChart('yahoo', 'HDFC', '5m', '2026-04-10')).not.toBeNull();

    vi.setSystemTime(new Date('2026-04-10T10:05:00Z'));
    expect(getCachedChart('yahoo', 'HDFC', '5m', '2026-04-10')).toBeNull();

    // Both payload + meta should have been evicted on the stale read.
    const payloadKey = _internals.buildKey('yahoo', 'HDFC', '5m', '2026-04-10');
    expect(localStorage.getItem(payloadKey)).toBeNull();
    expect(localStorage.getItem(payloadKey + _internals.META_SUFFIX)).toBeNull();
  });
});

describe('chartCacheLocal LRU eviction', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('evicts oldest ~10% when total size exceeds 4MB', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T09:00:00Z'));
    // Each payload ~516KB (8000 candles). 10 of them = ~5.1MB, past the
    // 4MB trigger. Age them so eviction order is deterministic by fetchedAt.
    const bigSeries = mkCandles(8000);
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(new Date(`2026-04-10T09:${String(i).padStart(2, '0')}:00Z`));
      setCachedChart('yahoo', `SYM${i}`, '1m', '2026-04-10', bigSeries);
    }

    // Count surviving payload keys (excluding :meta sidecars).
    let surviving = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(_internals.PREFIX) && !k.endsWith(_internals.META_SUFFIX)) {
        surviving++;
      }
    }
    // At least some entries were evicted when total size crossed the trigger.
    expect(surviving).toBeLessThan(10);

    // Oldest (SYM0) should have been evicted first.
    expect(getCachedChart('yahoo', 'SYM0', '1m', '2026-04-10')).toBeNull();
    vi.useRealTimers();
  });
});

describe('chartCacheLocal clearChartCache', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('clears a single symbol across intervals', () => {
    setCachedChart('yahoo', 'A', '1m', '2026-04-10', mkCandles(2));
    setCachedChart('yahoo', 'A', '5m', '2026-04-10', mkCandles(2));
    setCachedChart('yahoo', 'B', '1m', '2026-04-10', mkCandles(2));
    clearChartCache('yahoo', 'A');
    expect(getCachedChart('yahoo', 'A', '1m', '2026-04-10')).toBeNull();
    expect(getCachedChart('yahoo', 'A', '5m', '2026-04-10')).toBeNull();
    expect(getCachedChart('yahoo', 'B', '1m', '2026-04-10')).not.toBeNull();
  });

  it('clears an entire source when symbol omitted', () => {
    setCachedChart('yahoo', 'A', '1m', '2026-04-10', mkCandles(2));
    setCachedChart('dhan', 'A', '1m', '2026-04-10', mkCandles(2));
    clearChartCache('yahoo');
    expect(getCachedChart('yahoo', 'A', '1m', '2026-04-10')).toBeNull();
    expect(getCachedChart('dhan', 'A', '1m', '2026-04-10')).not.toBeNull();
  });
});

describe('chartCacheLocal graceful fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null / no-ops when localStorage is undefined', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => setCachedChart('yahoo', 'X', '1m', '2026-04-10', mkCandles(3))).not.toThrow();
    expect(getCachedChart('yahoo', 'X', '1m', '2026-04-10')).toBeNull();
    expect(() => clearChartCache('yahoo')).not.toThrow();
  });

  it('returns null when localStorage.getItem throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('disabled'); },
      setItem: () => { throw new Error('disabled'); },
      removeItem: () => {},
      get length() { return 0; },
      key: () => null,
    });
    expect(getCachedChart('yahoo', 'X', '1m', '2026-04-10')).toBeNull();
    // setCachedChart should swallow the throw without propagating.
    expect(() => setCachedChart('yahoo', 'X', '1m', '2026-04-10', mkCandles(2))).not.toThrow();
  });
});
