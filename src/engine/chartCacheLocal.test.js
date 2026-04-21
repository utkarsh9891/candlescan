import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getCachedChart,
  setCachedChart,
  clearChartCache,
  shouldCache,
  _internals,
} from './chartCacheLocal.js';

const IST_OFFSET_MS = 330 * 60_000;
function todayIST() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
function offsetIST(days) {
  return new Date(Date.now() + IST_OFFSET_MS + days * 86_400_000).toISOString().slice(0, 10);
}

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
    // Use 2026-04-09 so shouldCache() treats it as historical (< today IST).
    setCachedChart('yahoo', 'HDFC', '5m', '2026-04-09', mkCandles(4), { ttlMs: 60_000 });
    expect(getCachedChart('yahoo', 'HDFC', '5m', '2026-04-09')).not.toBeNull();

    vi.setSystemTime(new Date('2026-04-10T10:05:00Z'));
    expect(getCachedChart('yahoo', 'HDFC', '5m', '2026-04-09')).toBeNull();

    // Both payload + meta should have been evicted on the stale read.
    const payloadKey = _internals.buildKey('yahoo', 'HDFC', '5m', '2026-04-09');
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
    // Use 2026-04-09 so shouldCache() treats it as historical (< today IST).
    const bigSeries = mkCandles(8000);
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(new Date(`2026-04-10T09:${String(i).padStart(2, '0')}:00Z`));
      setCachedChart('yahoo', `SYM${i}`, '1m', '2026-04-09', bigSeries);
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
    expect(getCachedChart('yahoo', 'SYM0', '1m', '2026-04-09')).toBeNull();
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

describe('chartCacheLocal shouldCache (today-bypass correctness)', () => {
  it('bypasses cache when date is today IST (bars still forming)', () => {
    expect(shouldCache('yahoo', 'X', '1m', todayIST())).toBe(false);
  });
  it('allows cache for past IST dates', () => {
    expect(shouldCache('yahoo', 'X', '1m', offsetIST(-1))).toBe(true);
    expect(shouldCache('yahoo', 'X', '1m', offsetIST(-30))).toBe(true);
  });
  it('bypasses cache for future dates', () => {
    expect(shouldCache('yahoo', 'X', '1m', offsetIST(1))).toBe(false);
  });
  it('bypasses cache for "latest" / missing date (range queries)', () => {
    expect(shouldCache('yahoo', 'X', '1m', 'latest')).toBe(false);
    expect(shouldCache('yahoo', 'X', '1m', undefined)).toBe(false);
    expect(shouldCache('yahoo', 'X', '1m', null)).toBe(false);
    expect(shouldCache('yahoo', 'X', '1m', '')).toBe(false);
  });
  it('bypasses cache for malformed date strings', () => {
    expect(shouldCache('yahoo', 'X', '1m', 'yesterday')).toBe(false);
    expect(shouldCache('yahoo', 'X', '1m', '2026-04')).toBe(false);
    expect(shouldCache('yahoo', 'X', '1m', '26-04-2026')).toBe(false);
  });
});

describe('chartCacheLocal: set/get honor shouldCache', () => {
  beforeEach(() => { localStorage.clear(); });
  it('setCachedChart on today is a no-op', () => {
    const today = todayIST();
    setCachedChart('yahoo', 'RELIANCE', '1m', today, mkCandles(5));
    expect(getCachedChart('yahoo', 'RELIANCE', '1m', today)).toBeNull();
  });
  it('getCachedChart returns null for today even if a stale payload was manually written', () => {
    const today = todayIST();
    // Hand-write a payload at the exact key shape to simulate a poisoned entry.
    localStorage.setItem(
      `candlescan_chart:yahoo:RELIANCE:1m:${today}`,
      JSON.stringify({ candles: mkCandles(3), fetchedAt: Date.now(), expiresAt: Date.now() + 60_000 })
    );
    expect(getCachedChart('yahoo', 'RELIANCE', '1m', today)).toBeNull();
  });
  it('historical dates still cache normally', () => {
    const past = offsetIST(-2);
    setCachedChart('yahoo', 'RELIANCE', '1m', past, mkCandles(4));
    const hit = getCachedChart('yahoo', 'RELIANCE', '1m', past);
    expect(hit).not.toBeNull();
    expect(hit.candles.length).toBe(4);
  });
});
