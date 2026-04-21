import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getCachedNews,
  setCachedNews,
  clearNewsCache,
  _internals,
} from './newsCacheLocal.js';

describe('newsCacheLocal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns null on miss', () => {
    expect(getCachedNews('RELIANCE')).toBeNull();
  });

  it('round-trips a payload through set + get', () => {
    setCachedNews('RELIANCE', {
      score: 0.42,
      headlines: [{ title: 'earnings beat' }],
      source: 'google',
    });
    const hit = getCachedNews('RELIANCE');
    expect(hit).not.toBeNull();
    expect(hit.score).toBeCloseTo(0.42);
    expect(hit.headlines).toHaveLength(1);
    expect(hit.source).toBe('google');
    expect(hit.fetchedAt).toBeGreaterThan(0);
    expect(hit.expiresAt).toBeGreaterThan(hit.fetchedAt);
  });

  it('normalizes symbol (uppercase + strip .NS)', () => {
    setCachedNews('reliance.NS', {
      score: 0.1,
      headlines: [{ title: 'x' }],
      source: 'google',
    });
    const hit = getCachedNews('RELIANCE');
    expect(hit).not.toBeNull();
    expect(hit.score).toBeCloseTo(0.1);
  });

  it('writes a :meta sibling with fetchedAt/expiresAt/size', () => {
    setCachedNews('TCS', {
      score: 0.2,
      headlines: [{ title: 'h' }],
      source: 'google',
    });
    const key = _internals.buildKey('TCS');
    const metaRaw = localStorage.getItem(key + _internals.META_SUFFIX);
    expect(metaRaw).toBeTruthy();
    const meta = JSON.parse(metaRaw);
    expect(meta).toHaveProperty('size');
    expect(meta).toHaveProperty('fetchedAt');
    expect(meta).toHaveProperty('expiresAt');
    expect(meta.expiresAt).toBeGreaterThan(meta.fetchedAt);
  });

  it('evicts expired entries on read and returns null', () => {
    // Write an entry whose TTL has already passed.
    setCachedNews('INFY', {
      score: 0.3,
      headlines: [{ title: 'h' }],
      source: 'google',
    }, { ttlMs: 1000 });
    const key = _internals.buildKey('INFY');
    // Manually force expiresAt into the past.
    const raw = JSON.parse(localStorage.getItem(key));
    raw.expiresAt = Date.now() - 1;
    localStorage.setItem(key, JSON.stringify(raw));

    const hit = getCachedNews('INFY');
    expect(hit).toBeNull();
    // Both payload and meta were evicted.
    expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem(key + _internals.META_SUFFIX)).toBeNull();
  });

  it('does not cache a pure "no data" sentinel (score=null AND no headlines)', () => {
    setCachedNews('NODATA', { score: null, headlines: [], source: 'none' });
    expect(getCachedNews('NODATA')).toBeNull();
  });

  it('does cache when only headlines are present (score=null)', () => {
    setCachedNews('H_ONLY', { score: null, headlines: [{ title: 'x' }], source: 'stale' });
    const hit = getCachedNews('H_ONLY');
    expect(hit).not.toBeNull();
    expect(hit.headlines).toHaveLength(1);
    expect(hit.score).toBeNull();
    expect(hit.source).toBe('stale');
  });

  it('defaults TTL based on market hours (4h) or off-hours (12h)', () => {
    const isOpen = _internals.isMarketHoursIST();
    const ttl = _internals.defaultTtlMs();
    if (isOpen) {
      expect(ttl).toBe(_internals.TTL_MARKET_MS);
    } else {
      expect(ttl).toBe(_internals.TTL_OFFHOURS_MS);
    }
  });

  it('clearNewsCache(symbol) removes only that symbol', () => {
    setCachedNews('AAA', { score: 0.1, headlines: [{ title: 'a' }] });
    setCachedNews('BBB', { score: 0.2, headlines: [{ title: 'b' }] });
    clearNewsCache('AAA');
    expect(getCachedNews('AAA')).toBeNull();
    expect(getCachedNews('BBB')).not.toBeNull();
  });

  it('clearNewsCache() (no arg) wipes everything', () => {
    setCachedNews('AAA', { score: 0.1, headlines: [{ title: 'a' }] });
    setCachedNews('BBB', { score: 0.2, headlines: [{ title: 'b' }] });
    clearNewsCache();
    expect(getCachedNews('AAA')).toBeNull();
    expect(getCachedNews('BBB')).toBeNull();
  });

  it('is graceful when JSON is corrupt', () => {
    const key = _internals.buildKey('BROKEN');
    localStorage.setItem(key, '{not-valid-json');
    expect(getCachedNews('BROKEN')).toBeNull();
    // Auto-evicted
    expect(localStorage.getItem(key)).toBeNull();
  });
});
