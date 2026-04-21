import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  NSE_INDEX_CACHE_PREFIX,
  DEFAULT_TTL_MS,
  getCachedIndexSymbols,
  setCachedIndexSymbols,
  getStaleIndexSymbols,
  clearIndexCache,
  clearAllIndexCaches,
  summarizeIndexCache,
} from './nseIndexCache.js';

function makeStore() {
  const data = {};
  return {
    data,
    impl: {
      getItem: (k) => (k in data ? data[k] : null),
      setItem: (k, v) => { data[k] = String(v); },
      removeItem: (k) => { delete data[k]; },
      clear: () => { for (const k of Object.keys(data)) delete data[k]; },
      get length() { return Object.keys(data).length; },
      key: (i) => Object.keys(data)[i] ?? null,
    },
  };
}

describe('nseIndexCache', () => {
  let store;

  beforeEach(() => {
    store = makeStore();
    vi.stubGlobal('localStorage', store.impl);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('getCachedIndexSymbols / setCachedIndexSymbols', () => {
    it('round-trips a fresh entry', () => {
      setCachedIndexSymbols('NIFTY 200', ['RELIANCE', 'TCS']);
      const hit = getCachedIndexSymbols('NIFTY 200');
      expect(hit).not.toBeNull();
      expect(hit.symbols).toEqual(['RELIANCE', 'TCS']);
      expect(typeof hit.fetchedAt).toBe('number');
      expect(hit.expiresAt).toBeGreaterThan(hit.fetchedAt);
    });

    it('uses the documented key shape', () => {
      setCachedIndexSymbols('NIFTY SMALLCAP 100', ['A', 'B']);
      expect(store.data[`${NSE_INDEX_CACHE_PREFIX}NIFTY SMALLCAP 100`]).toBeDefined();
    });

    it('defaults the TTL to 7 days', () => {
      const before = Date.now();
      setCachedIndexSymbols('NIFTY 50', ['RELIANCE']);
      const hit = getCachedIndexSymbols('NIFTY 50');
      const ttl = hit.expiresAt - hit.fetchedAt;
      expect(ttl).toBe(DEFAULT_TTL_MS);
      expect(hit.fetchedAt).toBeGreaterThanOrEqual(before);
    });

    it('honors a custom ttlMs override', () => {
      setCachedIndexSymbols('NIFTY 50', ['RELIANCE'], { ttlMs: 1000 });
      const hit = getCachedIndexSymbols('NIFTY 50');
      expect(hit.expiresAt - hit.fetchedAt).toBe(1000);
    });

    it('returns null on miss', () => {
      expect(getCachedIndexSymbols('NIFTY 200')).toBeNull();
    });

    it('returns null for expired entries', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      setCachedIndexSymbols('NIFTY 200', ['RELIANCE'], { ttlMs: 60_000 });
      vi.setSystemTime(new Date('2026-01-01T00:02:00Z')); // 2 min later
      expect(getCachedIndexSymbols('NIFTY 200')).toBeNull();
    });

    it('treats the moment of expiry as expired', () => {
      vi.useFakeTimers();
      const t0 = new Date('2026-01-01T00:00:00Z').getTime();
      vi.setSystemTime(t0);
      setCachedIndexSymbols('NIFTY 200', ['RELIANCE'], { ttlMs: 1000 });
      vi.setSystemTime(t0 + 1000); // exactly at expiry
      expect(getCachedIndexSymbols('NIFTY 200')).toBeNull();
    });

    it('ignores empty symbol arrays', () => {
      setCachedIndexSymbols('NIFTY 200', []);
      expect(getCachedIndexSymbols('NIFTY 200')).toBeNull();
      expect(store.data[`${NSE_INDEX_CACHE_PREFIX}NIFTY 200`]).toBeUndefined();
    });

    it('ignores non-array inputs without throwing', () => {
      expect(() => setCachedIndexSymbols('NIFTY 200', null)).not.toThrow();
      expect(() => setCachedIndexSymbols('NIFTY 200', 'oops')).not.toThrow();
      expect(getCachedIndexSymbols('NIFTY 200')).toBeNull();
    });

    it('returns null for corrupt JSON and cleans it up', () => {
      store.data[`${NSE_INDEX_CACHE_PREFIX}NIFTY 200`] = '{not valid json';
      expect(getCachedIndexSymbols('NIFTY 200')).toBeNull();
      expect(store.data[`${NSE_INDEX_CACHE_PREFIX}NIFTY 200`]).toBeUndefined();
    });

    it('returns null for entries missing required fields', () => {
      store.data[`${NSE_INDEX_CACHE_PREFIX}NIFTY 200`] = JSON.stringify({ symbols: ['RELIANCE'] });
      expect(getCachedIndexSymbols('NIFTY 200')).toBeNull();
    });
  });

  describe('getStaleIndexSymbols', () => {
    it('returns an expired entry verbatim', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      setCachedIndexSymbols('NIFTY 200', ['RELIANCE'], { ttlMs: 1000 });
      vi.setSystemTime(new Date('2026-01-02T00:00:00Z')); // way past expiry

      expect(getCachedIndexSymbols('NIFTY 200')).toBeNull();
      const stale = getStaleIndexSymbols('NIFTY 200');
      expect(stale).not.toBeNull();
      expect(stale.symbols).toEqual(['RELIANCE']);
    });

    it('still works for fresh entries (used as a generic read)', () => {
      setCachedIndexSymbols('NIFTY 200', ['TCS']);
      const got = getStaleIndexSymbols('NIFTY 200');
      expect(got.symbols).toEqual(['TCS']);
    });

    it('returns null when nothing is stored', () => {
      expect(getStaleIndexSymbols('NIFTY 200')).toBeNull();
    });
  });

  describe('clearIndexCache / clearAllIndexCaches', () => {
    it('clearIndexCache removes just the one entry', () => {
      setCachedIndexSymbols('NIFTY 200', ['A']);
      setCachedIndexSymbols('NIFTY 50', ['B']);
      clearIndexCache('NIFTY 200');
      expect(getCachedIndexSymbols('NIFTY 200')).toBeNull();
      expect(getCachedIndexSymbols('NIFTY 50')).not.toBeNull();
    });

    it('clearAllIndexCaches drops every index cache key', () => {
      setCachedIndexSymbols('NIFTY 200', ['A']);
      setCachedIndexSymbols('NIFTY 50', ['B']);
      // Unrelated keys must survive
      store.impl.setItem('unrelated_key', 'keep-me');
      clearAllIndexCaches();
      expect(getCachedIndexSymbols('NIFTY 200')).toBeNull();
      expect(getCachedIndexSymbols('NIFTY 50')).toBeNull();
      expect(store.impl.getItem('unrelated_key')).toBe('keep-me');
    });
  });

  describe('summarizeIndexCache', () => {
    it('reports count=0 when empty', () => {
      const s = summarizeIndexCache();
      expect(s.count).toBe(0);
      expect(s.oldestAgeMs).toBe(0);
    });

    it('counts entries and reports the oldest age', () => {
      vi.useFakeTimers();
      const t0 = new Date('2026-04-01T00:00:00Z').getTime();
      vi.setSystemTime(t0);
      setCachedIndexSymbols('NIFTY 200', ['A']);
      vi.setSystemTime(t0 + 3 * 60 * 60 * 1000); // 3h later
      setCachedIndexSymbols('NIFTY 50', ['B']);
      vi.setSystemTime(t0 + 5 * 60 * 60 * 1000); // 5h after the first

      const s = summarizeIndexCache();
      expect(s.count).toBe(2);
      expect(s.oldestAgeMs).toBe(5 * 60 * 60 * 1000);
    });
  });

  describe('localStorage unavailable', () => {
    it('reads return null, writes no-op, clears no-op', () => {
      // Make every localStorage access throw — emulates a locked-down browser.
      vi.stubGlobal('localStorage', undefined);
      expect(() => setCachedIndexSymbols('NIFTY 200', ['A'])).not.toThrow();
      expect(getCachedIndexSymbols('NIFTY 200')).toBeNull();
      expect(getStaleIndexSymbols('NIFTY 200')).toBeNull();
      expect(() => clearIndexCache('NIFTY 200')).not.toThrow();
      expect(() => clearAllIndexCaches()).not.toThrow();
      const s = summarizeIndexCache();
      expect(s).toEqual({ count: 0, oldestAgeMs: 0 });
    });

    it('swallows quota errors from setItem', () => {
      const throwingLs = {
        ...store.impl,
        setItem: () => { throw new Error('QuotaExceededError'); },
      };
      vi.stubGlobal('localStorage', throwingLs);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => setCachedIndexSymbols('NIFTY 200', ['A'])).not.toThrow();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
