/**
 * Unit tests for `worker/cache.js` — the KV-backed cache helpers that
 * back `/market/vix`, `/market/fiidii`, `/news/moneycontrol`,
 * `/news/google` in the Cloudflare Worker.
 *
 * The core coverage targets:
 *   - KV hit returns cached value without calling the upstream fetcher.
 *   - Miss triggers upstream fetch + a KV write.
 *   - Upstream failure with an existing cached entry returns stale + STALE marker.
 *   - Upstream failure with no cache returns the unavailable sentinel (or bubbles).
 *   - Write-dedupe micro-cache skips a second write within 30s.
 *   - Key/TTL helpers behave across IST boundaries + market hours.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  kvCacheFlow,
  kvWriteWithDedupe,
  kvReadEnvelope,
  cacheHeaders,
  istDateString,
  isMarketHoursIST,
  vixKey,
  vixTtlMs,
  fiidiiKey,
  FIIDII_TTL_MS,
  moneycontrolKey,
  moneycontrolTtlMs,
  googleNewsKey,
  GOOGLE_NEWS_TTL_MS,
  GOOGLE_NEWS_STALE_MAX_MS,
  _resetCacheState,
  _getCacheCounters,
} from './cache.js';

/**
 * Minimal in-memory KV stub that matches the subset of the CF
 * `KVNamespace` surface our worker uses: `get(key, 'json')` and
 * `put(key, value, { expirationTtl })`. Writes are tracked so tests
 * can assert dedupe behaviour.
 */
function makeKvStub() {
  const store = new Map();
  let writeCount = 0;
  return {
    store,
    writeCount: () => writeCount,
    async get(key, type) {
      const raw = store.get(key);
      if (raw == null) return null;
      if (type === 'json') {
        try { return JSON.parse(raw); } catch { return null; }
      }
      return raw;
    },
    async put(key, value) {
      writeCount += 1;
      store.set(key, value);
    },
    async delete(key) { store.delete(key); },
  };
}

beforeEach(() => {
  _resetCacheState();
});

describe('istDateString', () => {
  it('returns YYYY-MM-DD in IST for a UTC timestamp', () => {
    // 2026-04-21T18:30:00Z = 2026-04-22T00:00:00 IST — boundary case
    const ts = Date.UTC(2026, 3, 21, 18, 30, 0);
    expect(istDateString(ts)).toBe('2026-04-22');
  });

  it('handles a daytime IST timestamp', () => {
    // 2026-04-21T05:00:00Z = 2026-04-21T10:30:00 IST
    const ts = Date.UTC(2026, 3, 21, 5, 0, 0);
    expect(istDateString(ts)).toBe('2026-04-21');
  });
});

describe('isMarketHoursIST', () => {
  it('returns true for 10:00 IST', () => {
    // 10:00 IST = 04:30 UTC
    const ts = Date.UTC(2026, 3, 21, 4, 30, 0);
    expect(isMarketHoursIST(ts)).toBe(true);
  });

  it('returns true at 15:45 IST boundary', () => {
    // 15:45 IST = 10:15 UTC
    const ts = Date.UTC(2026, 3, 21, 10, 15, 0);
    expect(isMarketHoursIST(ts)).toBe(true);
  });

  it('returns false at 08:59 IST', () => {
    // 08:59 IST = 03:29 UTC
    const ts = Date.UTC(2026, 3, 21, 3, 29, 0);
    expect(isMarketHoursIST(ts)).toBe(false);
  });

  it('returns false at 16:00 IST', () => {
    // 16:00 IST = 10:30 UTC
    const ts = Date.UTC(2026, 3, 21, 10, 30, 0);
    expect(isMarketHoursIST(ts)).toBe(false);
  });
});

describe('TTL helpers', () => {
  it('vixTtlMs is 1h during market hours', () => {
    const ts = Date.UTC(2026, 3, 21, 4, 30, 0); // 10:00 IST
    expect(vixTtlMs(ts)).toBe(60 * 60 * 1000);
  });
  it('vixTtlMs is 24h off-hours', () => {
    const ts = Date.UTC(2026, 3, 21, 3, 0, 0); // 08:30 IST
    expect(vixTtlMs(ts)).toBe(24 * 60 * 60 * 1000);
  });
  it('moneycontrolTtlMs is 10min market hours', () => {
    const ts = Date.UTC(2026, 3, 21, 4, 30, 0); // 10:00 IST
    expect(moneycontrolTtlMs(ts)).toBe(10 * 60 * 1000);
  });
  it('moneycontrolTtlMs is 60min off-hours', () => {
    const ts = Date.UTC(2026, 3, 21, 3, 0, 0); // 08:30 IST
    expect(moneycontrolTtlMs(ts)).toBe(60 * 60 * 1000);
  });
});

describe('key builders', () => {
  it('vixKey uses IST date', () => {
    const ts = Date.UTC(2026, 3, 21, 5, 0, 0);
    expect(vixKey(ts)).toBe('nse_vix_daily:2026-04-21');
  });
  it('fiidiiKey uses IST date', () => {
    const ts = Date.UTC(2026, 3, 21, 5, 0, 0);
    expect(fiidiiKey(ts)).toBe('nse_fiidii_daily:2026-04-21');
  });
  it('googleNewsKey includes symbol + IST date', () => {
    const ts = Date.UTC(2026, 3, 21, 5, 0, 0);
    expect(googleNewsKey('RELIANCE', ts)).toBe('google_news:RELIANCE:2026-04-21');
  });
  it('moneycontrolKey buckets by TTL window', () => {
    // Two timestamps 5 minutes apart during market hours share the same
    // 10-min bucket.
    const a = Date.UTC(2026, 3, 21, 4, 30, 0); // 10:00 IST
    const b = Date.UTC(2026, 3, 21, 4, 34, 59); // 10:04:59 IST
    expect(moneycontrolKey(a)).toBe(moneycontrolKey(b));
    // A timestamp in the next bucket differs.
    const c = Date.UTC(2026, 3, 21, 4, 40, 0); // 10:10 IST
    expect(moneycontrolKey(a)).not.toBe(moneycontrolKey(c));
  });
});

describe('cacheHeaders', () => {
  it('includes X-Cache + X-Cache-Key', () => {
    const h = cacheHeaders({ status: 'HIT', key: 'foo:bar', ageMs: 5000 });
    expect(h['X-Cache']).toBe('HIT');
    expect(h['X-Cache-Key']).toBe('foo:bar');
    expect(h['X-Cache-Age']).toBe('5');
  });
  it('includes cacheSource when provided', () => {
    const h = cacheHeaders({ status: 'STALE', key: 'x', ageMs: 100, cacheSource: 'stale' });
    expect(h['X-Cache-Source']).toBe('stale');
  });
  it('omits X-Cache-Age when not provided', () => {
    const h = cacheHeaders({ status: 'MISS', key: 'x' });
    expect(h).not.toHaveProperty('X-Cache-Age');
  });
});

describe('kvReadEnvelope', () => {
  it('returns null on miss', async () => {
    const kv = makeKvStub();
    expect(await kvReadEnvelope(kv, 'missing')).toBeNull();
  });

  it('returns value + ageMs on hit', async () => {
    const kv = makeKvStub();
    const writtenAt = Date.now() - 5000;
    kv.store.set('k', JSON.stringify({ value: { foo: 1 }, writtenAt }));
    const r = await kvReadEnvelope(kv, 'k');
    expect(r).not.toBeNull();
    expect(r.value).toEqual({ foo: 1 });
    expect(r.ageMs).toBeGreaterThanOrEqual(5000);
  });

  it('returns null on malformed envelope', async () => {
    const kv = makeKvStub();
    kv.store.set('k', JSON.stringify({ noValue: true }));
    expect(await kvReadEnvelope(kv, 'k')).toBeNull();
  });

  it('returns null when KV is null', async () => {
    expect(await kvReadEnvelope(null, 'k')).toBeNull();
  });
});

describe('kvWriteWithDedupe', () => {
  it('writes on first call', async () => {
    const kv = makeKvStub();
    const wrote = await kvWriteWithDedupe(kv, 'k', { hello: 'world' }, 600);
    expect(wrote).toBe(true);
    expect(kv.writeCount()).toBe(1);
    const stored = JSON.parse(kv.store.get('k'));
    expect(stored.value).toEqual({ hello: 'world' });
    expect(typeof stored.writtenAt).toBe('number');
  });

  it('skips a second write within 30s', async () => {
    const kv = makeKvStub();
    const a = await kvWriteWithDedupe(kv, 'k', { a: 1 }, 600);
    const b = await kvWriteWithDedupe(kv, 'k', { b: 2 }, 600);
    expect(a).toBe(true);
    expect(b).toBe(false);
    expect(kv.writeCount()).toBe(1);
    expect(_getCacheCounters().kvWritesSkipped).toBe(1);
  });

  it('allows writes to different keys independently', async () => {
    const kv = makeKvStub();
    await kvWriteWithDedupe(kv, 'k1', { a: 1 }, 600);
    await kvWriteWithDedupe(kv, 'k2', { b: 2 }, 600);
    expect(kv.writeCount()).toBe(2);
  });

  it('returns false when KV binding is missing', async () => {
    const wrote = await kvWriteWithDedupe(null, 'k', { x: 1 }, 600);
    expect(wrote).toBe(false);
  });

  it('clamps TTLs below 60 seconds', async () => {
    const kv = {
      writes: [],
      async get() { return null; },
      async put(key, value, opts) { this.writes.push({ key, opts }); },
    };
    await kvWriteWithDedupe(kv, 'k', { x: 1 }, 30);
    expect(kv.writes[0].opts.expirationTtl).toBe(60);
  });
});

describe('kvCacheFlow', () => {
  it('returns HIT when KV has a fresh value', async () => {
    const kv = makeKvStub();
    kv.store.set('k', JSON.stringify({ value: { cached: true }, writtenAt: Date.now() - 1000 }));
    let upstreamCalled = false;
    const result = await kvCacheFlow({
      kv, key: 'k',
      ttlMs: 60_000, staleMaxMs: 600_000,
      fetchFresh: async () => { upstreamCalled = true; return { fresh: true }; },
    });
    expect(result.status).toBe('HIT');
    expect(result.payload).toEqual({ cached: true });
    expect(upstreamCalled).toBe(false);
    expect(kv.writeCount()).toBe(0);
  });

  it('returns MISS + writes KV when cache is empty', async () => {
    const kv = makeKvStub();
    const result = await kvCacheFlow({
      kv, key: 'k',
      ttlMs: 60_000, staleMaxMs: 600_000,
      fetchFresh: async () => ({ fresh: true }),
    });
    expect(result.status).toBe('MISS');
    expect(result.payload).toEqual({ fresh: true });
    expect(kv.writeCount()).toBe(1);
  });

  it('treats expired cache entry as miss and refetches', async () => {
    const kv = makeKvStub();
    // Entry older than ttlMs
    kv.store.set('k', JSON.stringify({ value: { old: true }, writtenAt: Date.now() - 120_000 }));
    const result = await kvCacheFlow({
      kv, key: 'k',
      ttlMs: 60_000, staleMaxMs: 3600_000,
      fetchFresh: async () => ({ fresh: true }),
    });
    expect(result.status).toBe('MISS');
    expect(result.payload).toEqual({ fresh: true });
  });

  it('returns STALE when upstream fails but cached entry exists', async () => {
    const kv = makeKvStub();
    // Cached entry older than ttl but within staleMax
    kv.store.set('k', JSON.stringify({ value: { old: true }, writtenAt: Date.now() - 120_000 }));
    const result = await kvCacheFlow({
      kv, key: 'k',
      ttlMs: 60_000, staleMaxMs: 3600_000,
      fetchFresh: async () => { throw new Error('Google 502'); },
    });
    expect(result.status).toBe('STALE');
    expect(result.payload).toEqual({ old: true });
    expect(result.warnMessage).toContain('STALE');
    expect(result.warnMessage).toContain('Google 502');
  });

  it('returns UNAVAILABLE sentinel when upstream fails + no cache', async () => {
    const kv = makeKvStub();
    const result = await kvCacheFlow({
      kv, key: 'g:RELIANCE:2026-04-21',
      ttlMs: 60_000, staleMaxMs: 3600_000,
      fetchFresh: async () => { throw new Error('Google 502'); },
      unavailablePayload: () => ({ headlines: [], score: null, source: 'unavailable' }),
    });
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.payload).toEqual({ headlines: [], score: null, source: 'unavailable' });
    expect(result.warnMessage).toContain('UNAVAILABLE');
  });

  it('bubbles upstream error when no cache + no unavailablePayload', async () => {
    const kv = makeKvStub();
    await expect(kvCacheFlow({
      kv, key: 'k',
      ttlMs: 60_000, staleMaxMs: 3600_000,
      fetchFresh: async () => { throw new Error('boom'); },
    })).rejects.toThrow('boom');
  });

  it('skips stale fallback when cached entry is older than staleMaxMs', async () => {
    const kv = makeKvStub();
    // Entry older than both ttlMs AND staleMaxMs
    kv.store.set('k', JSON.stringify({ value: { ancient: true }, writtenAt: Date.now() - 999_999_999 }));
    await expect(kvCacheFlow({
      kv, key: 'k',
      ttlMs: 60_000, staleMaxMs: 3600_000,
      fetchFresh: async () => { throw new Error('boom'); },
    })).rejects.toThrow('boom');
  });

  it('works with null KV binding (no caching, just passes through upstream)', async () => {
    const result = await kvCacheFlow({
      kv: null, key: 'k',
      ttlMs: 60_000, staleMaxMs: 3600_000,
      fetchFresh: async () => ({ fresh: true }),
    });
    expect(result.status).toBe('MISS');
    expect(result.payload).toEqual({ fresh: true });
  });
});

describe('integration — Google-News style flow', () => {
  it('uses GOOGLE_NEWS_TTL_MS=4h and STALE_MAX=24h', () => {
    expect(GOOGLE_NEWS_TTL_MS).toBe(4 * 60 * 60 * 1000);
    expect(GOOGLE_NEWS_STALE_MAX_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('FII/DII TTL is 6h', () => {
    expect(FIIDII_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('full stale-fallback path — pre-warmed cache, then upstream 502', async () => {
    const kv = makeKvStub();

    // First call — cache miss, upstream succeeds.
    const first = await kvCacheFlow({
      kv,
      key: googleNewsKey('RELIANCE'),
      ttlMs: GOOGLE_NEWS_TTL_MS,
      staleMaxMs: GOOGLE_NEWS_STALE_MAX_MS,
      fetchFresh: async () => ({ symbol: 'RELIANCE', items: [{ title: 'Reliance up 2%' }], count: 1 }),
      unavailablePayload: () => ({ items: [], source: 'unavailable' }),
    });
    expect(first.status).toBe('MISS');
    expect(kv.writeCount()).toBe(1);

    // Simulate cache being a bit stale (past ttlMs but within staleMaxMs).
    const stored = JSON.parse(kv.store.get(googleNewsKey('RELIANCE')));
    stored.writtenAt = Date.now() - (GOOGLE_NEWS_TTL_MS + 1000);
    kv.store.set(googleNewsKey('RELIANCE'), JSON.stringify(stored));

    // Second call — upstream is 502ing (Google is degraded).
    const second = await kvCacheFlow({
      kv,
      key: googleNewsKey('RELIANCE'),
      ttlMs: GOOGLE_NEWS_TTL_MS,
      staleMaxMs: GOOGLE_NEWS_STALE_MAX_MS,
      fetchFresh: async () => { throw new Error('Google RSS HTTP 502'); },
      unavailablePayload: () => ({ items: [], source: 'unavailable' }),
    });
    expect(second.status).toBe('STALE');
    expect(second.payload.items[0].title).toBe('Reliance up 2%');
  });
});
