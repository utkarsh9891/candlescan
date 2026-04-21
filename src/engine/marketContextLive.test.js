import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchLiveVix,
  fetchLiveFiiDii,
  fetchLiveNews,
  fetchLiveMarketContext,
  clearMarketContextCache,
} from './marketContextLive.js';

// 10-minute TTL matches the module constant CACHE_TTL_MS.
const TEN_MIN = 10 * 60 * 1000;

function mockFetchOnce(body, { ok = true, status = 200 } = {}) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  }));
}

let originalFetch;
beforeEach(() => {
  clearMarketContextCache();
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  clearMarketContextCache();
});

describe('fetchLiveVix caching', () => {
  it('fetches once, serves from cache within TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T04:00:00Z'));
    globalThis.fetch = mockFetchOnce({ vix: 20 });

    const a = await fetchLiveVix();
    const b = await fetchLiveVix();
    expect(a.vix).toBe(20);
    expect(b.vix).toBe(20);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('refetches after TTL expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T04:00:00Z'));
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ vix: 20 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ vix: 30 }) });

    const a = await fetchLiveVix();
    expect(a.vix).toBe(20);

    // Advance just past the 10-min TTL.
    vi.setSystemTime(new Date(Date.now() + TEN_MIN + 1));
    const b = await fetchLiveVix();
    expect(b.vix).toBe(30);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('classifies regime on each read (fresh and cached)', async () => {
    globalThis.fetch = mockFetchOnce({ vix: 30 }); // above PANIC threshold
    const a = await fetchLiveVix();
    expect(a.regime).toBeTruthy();
    const b = await fetchLiveVix(); // cached
    expect(b.regime).toBe(a.regime);
  });

  it('de-duplicates concurrent calls to a single fetch', async () => {
    // Use a deferred resolution to keep the first call in flight.
    let resolveFetch;
    globalThis.fetch = vi.fn(() =>
      new Promise((resolve) => {
        resolveFetch = () => resolve({ ok: true, status: 200, json: async () => ({ vix: 25 }) });
      })
    );

    const p1 = fetchLiveVix();
    const p2 = fetchLiveVix();
    const p3 = fetchLiveVix();
    resolveFetch();
    const [a, b, c] = await Promise.all([p1, p2, p3]);
    expect(a.vix).toBe(25);
    expect(b.vix).toBe(25);
    expect(c.vix).toBe(25);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not cache failures — retries on next call', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ vix: 18 }) });

    const a = await fetchLiveVix();
    expect(a.vix).toBeNull();
    const b = await fetchLiveVix();
    expect(b.vix).toBe(18);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('fetchLiveFiiDii caching', () => {
  it('caches within TTL and refetches after', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T04:00:00Z'));
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ fii: 100, dii: 200 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ fii: -50, dii: 150 }) });

    const a = await fetchLiveFiiDii();
    const b = await fetchLiveFiiDii();
    expect(a.fii).toBe(100);
    expect(b.fii).toBe(100);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + TEN_MIN + 1));
    const c = await fetchLiveFiiDii();
    expect(c.fii).toBe(-50);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('fetchLiveNews per-universe scoring', () => {
  it('recomputes scoreMap for different universes while reusing raw items', async () => {
    const items = [
      { title: 'RELIANCE soars on earnings beat', description: 'strong growth' },
      { title: 'HDFCBANK surges after results', description: 'beats estimates' },
    ];
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ items }),
    }));

    const universeA = new Set(['RELIANCE']);
    const universeB = new Set(['HDFCBANK']);

    const resA = await fetchLiveNews(universeA);
    const resB = await fetchLiveNews(universeB);

    // Raw-items fetch is cached — only one network call for both.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // But score maps reflect each caller's universe, not the first one's.
    expect(Object.keys(resA.scoreMap)).toContain('RELIANCE');
    expect(Object.keys(resA.scoreMap)).not.toContain('HDFCBANK');
    expect(Object.keys(resB.scoreMap)).toContain('HDFCBANK');
    expect(Object.keys(resB.scoreMap)).not.toContain('RELIANCE');
  });

  it('returns empty maps gracefully on fetch failure', async () => {
    globalThis.fetch = mockFetchOnce({}, { ok: false, status: 503 });
    const res = await fetchLiveNews(new Set(['RELIANCE']));
    expect(res.scoreMap).toEqual({});
    expect(res.headlinesMap).toEqual({});
  });
});

describe('fetchLiveMarketContext', () => {
  it('composes layers without the old day-cache pinning', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T04:00:00Z'));
    // Route each CF endpoint to its own response.
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith('/market/vix')) return { ok: true, status: 200, json: async () => ({ vix: 20 }) };
      if (u.endsWith('/market/fiidii')) return { ok: true, status: 200, json: async () => ({ fii: 1, dii: 2 }) };
      if (u.endsWith('/news/moneycontrol')) return { ok: true, status: 200, json: async () => ({ items: [] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const ctx = await fetchLiveMarketContext(new Set(['RELIANCE']));
    expect(ctx.vix).toBe(20);
    expect(ctx.fii).toBe(1);
    expect(ctx.dii).toBe(2);

    // Flip the VIX response and advance past TTL — the old code would
    // have pinned 20 for the whole trading day. With the TTL fix, the
    // next compose sees the new value.
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith('/market/vix')) return { ok: true, status: 200, json: async () => ({ vix: 30 }) };
      if (u.endsWith('/market/fiidii')) return { ok: true, status: 200, json: async () => ({ fii: 1, dii: 2 }) };
      if (u.endsWith('/news/moneycontrol')) return { ok: true, status: 200, json: async () => ({ items: [] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.setSystemTime(new Date(Date.now() + TEN_MIN + 1));
    const ctx2 = await fetchLiveMarketContext(new Set(['RELIANCE']));
    expect(ctx2.vix).toBe(30);
  });
});

describe('clearMarketContextCache', () => {
  it('forces refetch of every layer on the next call', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith('/market/vix')) return { ok: true, status: 200, json: async () => ({ vix: 20 }) };
      if (u.endsWith('/market/fiidii')) return { ok: true, status: 200, json: async () => ({ fii: 1, dii: 2 }) };
      if (u.endsWith('/news/moneycontrol')) return { ok: true, status: 200, json: async () => ({ items: [] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    });

    await fetchLiveMarketContext(new Set(['RELIANCE']));
    const callsBefore = globalThis.fetch.mock.calls.length;

    // Second compose within the TTL → cache hits everywhere, no new calls.
    await fetchLiveMarketContext(new Set(['RELIANCE']));
    expect(globalThis.fetch.mock.calls.length).toBe(callsBefore);

    clearMarketContextCache();
    await fetchLiveMarketContext(new Set(['RELIANCE']));
    // Three endpoints refetched after clear.
    expect(globalThis.fetch.mock.calls.length).toBe(callsBefore + 3);
  });
});
