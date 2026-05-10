/**
 * Integration tests for the four KV-cached Worker handlers:
 *   - /market/vix         → handleVixFetch
 *   - /market/fiidii      → handleFiiDiiFetch
 *   - /news/india         → handleIndiaNews
 *   - /news/google        → handleGoogleNewsForSymbol
 *
 * Rather than stand up a real Cloudflare Worker, we import the
 * module's default `fetch` export and call it with synthetic Request
 * + env objects. The test overrides `globalThis.fetch` per-test to
 * simulate upstream success / 502 / timeout, and passes a stubbed
 * `CANDLESCAN_KV` binding (see `./cache.test.js` for the shared stub).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import worker from './index.js';
import { _resetCacheState } from './cache.js';

// ───────────────────────────────────────────────────────────
// KV stub — matches `./cache.test.js`
// ───────────────────────────────────────────────────────────
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

function makeRequest(path, { method = 'GET' } = {}) {
  return new Request(`https://candlescan-proxy.workers.dev${path}`, {
    method,
    headers: { Origin: 'https://utkarsh9891.github.io' },
  });
}

function jsonResp(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  _resetCacheState();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ───────────────────────────────────────────────────────────
// /market/vix
// ───────────────────────────────────────────────────────────
describe('handleVixFetch', () => {
  it('MISS on empty cache → upstream fetch → 200 with X-Cache=MISS', async () => {
    globalThis.fetch = vi.fn(async () => jsonResp({
      chart: { result: [{ indicators: { quote: [{ close: [11.5, 12.1, 12.9] }] } }] },
    }));
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/market/vix'), { CANDLESCAN_KV: kv });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('X-Cache')).toBe('MISS');
    expect(resp.headers.get('X-Cache-Key')).toMatch(/^nse_vix_daily:\d{4}-\d{2}-\d{2}$/);
    const body = await resp.json();
    expect(body.vix).toBe(12.9);
    // Write happened
    expect(kv.writeCount()).toBe(1);
  });

  it('HIT on second call without re-fetching upstream', async () => {
    const fetchMock = vi.fn(async () => jsonResp({
      chart: { result: [{ indicators: { quote: [{ close: [12.9] }] } }] },
    }));
    globalThis.fetch = fetchMock;
    const kv = makeKvStub();
    await worker.fetch(makeRequest('/market/vix'), { CANDLESCAN_KV: kv });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Second call — should be a HIT
    const resp2 = await worker.fetch(makeRequest('/market/vix'), { CANDLESCAN_KV: kv });
    expect(resp2.headers.get('X-Cache')).toBe('HIT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('STALE fallback when upstream 502s + cache entry is past TTL', async () => {
    // Seed KV with an entry that is past ttl but within staleMax.
    const kv = makeKvStub();
    const veryOld = Date.now() - 25 * 60 * 60 * 1000; // 25h — actually past staleMax for off-hours
    // Use 2h-old instead so it's within the 24h staleMax
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const key = `nse_vix_daily:${new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)}`;
    kv.store.set(key, JSON.stringify({
      value: { vix: 13.7, fetchedAt: new Date(twoHoursAgo).toISOString() },
      writtenAt: twoHoursAgo,
    }));
    // Upstream 502
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 502 }));
    const resp = await worker.fetch(makeRequest('/market/vix'), { CANDLESCAN_KV: kv });
    // During market hours TTL=1h, so a 2h-old entry is stale → should be returned as STALE.
    // Off-hours TTL=24h, so a 2h-old entry is HIT.
    const cacheStatus = resp.headers.get('X-Cache');
    expect(['STALE', 'HIT']).toContain(cacheStatus);
    const body = await resp.json();
    expect(body.vix).toBe(13.7);
    // unused var silences lint in CI
    void veryOld;
  });

  it('UNAVAILABLE → 502 when upstream fails + no cache', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 502 }));
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/market/vix'), { CANDLESCAN_KV: kv });
    expect(resp.status).toBe(502);
    expect(resp.headers.get('X-Cache')).toBe('UNAVAILABLE');
  });
});

// ───────────────────────────────────────────────────────────
// /market/fiidii
// ───────────────────────────────────────────────────────────
describe('handleFiiDiiFetch', () => {
  it('MISS → upstream fetch → 200', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async (url) => {
      call++;
      if (String(url).includes('nseindia.com/') && !String(url).includes('/api/')) {
        return new Response('<html>ok</html>', {
          status: 200,
          headers: { 'set-cookie': 'nsit=abc; Path=/, nseappid=xyz; Path=/' },
        });
      }
      return jsonResp([
        { category: 'FII/FPI *', netValue: '1234.5', date: '21-Apr-2026' },
        { category: 'DII **', netValue: '-567.8', date: '21-Apr-2026' },
      ]);
    });
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/market/fiidii'), { CANDLESCAN_KV: kv });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('X-Cache')).toBe('MISS');
    const body = await resp.json();
    expect(body.fii).toBeCloseTo(1234.5);
    expect(body.dii).toBeCloseTo(-567.8);
    void call;
  });

  it('HIT on second call', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('nseindia.com/') && !String(url).includes('/api/')) {
        return new Response('<html>ok</html>', {
          status: 200,
          headers: { 'set-cookie': 'nsit=abc' },
        });
      }
      return jsonResp([
        { category: 'FII/FPI', netValue: '100', date: '21-Apr-2026' },
        { category: 'DII', netValue: '200', date: '21-Apr-2026' },
      ]);
    });
    globalThis.fetch = fetchMock;
    const kv = makeKvStub();
    await worker.fetch(makeRequest('/market/fiidii'), { CANDLESCAN_KV: kv });
    const cbBefore = fetchMock.mock.calls.length;
    const resp2 = await worker.fetch(makeRequest('/market/fiidii'), { CANDLESCAN_KV: kv });
    expect(resp2.headers.get('X-Cache')).toBe('HIT');
    expect(fetchMock.mock.calls.length).toBe(cbBefore);
  });

  it('STALE on upstream 502 when cache exists', async () => {
    const kv = makeKvStub();
    const key = `nse_fiidii_daily:${new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)}`;
    // Write an entry 7h old — past 6h TTL, within 48h stale window
    kv.store.set(key, JSON.stringify({
      value: { fii: 100, dii: 200, date: '21-Apr-2026', fetchedAt: new Date().toISOString() },
      writtenAt: Date.now() - 7 * 60 * 60 * 1000,
    }));
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 502 }));
    const resp = await worker.fetch(makeRequest('/market/fiidii'), { CANDLESCAN_KV: kv });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('X-Cache')).toBe('STALE');
    const body = await resp.json();
    expect(body.fii).toBe(100);
  });
});

// ───────────────────────────────────────────────────────────
// /news/india  (Moneycontrol + LiveMint + ET + Business Standard)
// ───────────────────────────────────────────────────────────
describe('handleIndiaNews', () => {
  it('MISS → fetches all configured feeds → returns merged items', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      '<rss><channel><item><title>Reliance Q4 result beats</title><description>Strong earnings</description></item></channel></rss>',
      { status: 200, headers: { 'Content-Type': 'application/xml' } },
    ));
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/news/india'), { CANDLESCAN_KV: kv });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('X-Cache')).toBe('MISS');
    const body = await resp.json();
    expect(body.count).toBeGreaterThan(0);
  });

  it('tags each item with the publisher of the originating feed', async () => {
    // Map each upstream feed to a publisher-specific headline so we
    // can assert the publisher field is populated end-to-end.
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      let title = 'Generic';
      if (u.includes('moneycontrol.com')) title = 'MC: Reliance up';
      else if (u.includes('livemint.com')) title = 'Mint: TCS in focus';
      else if (u.includes('economictimes.indiatimes.com')) title = 'ET: HDFC rallies';
      else if (u.includes('business-standard.com')) title = 'BS: INFY hits high';
      return new Response(
        `<rss><channel><item><title>${title}</title></item></channel></rss>`,
        { status: 200 },
      );
    });
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/news/india'), { CANDLESCAN_KV: kv });
    const body = await resp.json();
    const publishers = new Set(body.items.map((it) => it.publisher));
    expect(publishers.has('Moneycontrol')).toBe(true);
    expect(publishers.has('LiveMint')).toBe(true);
    expect(publishers.has('Economic Times')).toBe(true);
    expect(publishers.has('Business Standard')).toBe(true);
  });

  it('UNAVAILABLE sentinel when all feeds 502 + no cache', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 502 }));
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/news/india'), { CANDLESCAN_KV: kv });
    expect(resp.status).toBe(200); // UNAVAILABLE returns 200 so callers don't retry
    expect(resp.headers.get('X-Cache')).toBe('UNAVAILABLE');
    const body = await resp.json();
    expect(body.count).toBe(0);
    expect(body.source).toBe('unavailable');
  });
});

// ───────────────────────────────────────────────────────────
// /news/google
// ───────────────────────────────────────────────────────────
describe('handleGoogleNewsForSymbol', () => {
  it('400 on missing symbol', async () => {
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/news/google'), { CANDLESCAN_KV: kv });
    expect(resp.status).toBe(400);
  });

  it('MISS → upstream fetch → 200 with X-Cache-Source=miss', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      '<rss><channel><item><title>RELIANCE stock up 2%</title><description>Rally</description><pubDate>Mon, 21 Apr 2026 10:00:00 GMT</pubDate></item></channel></rss>',
      { status: 200 },
    ));
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/news/google?symbol=RELIANCE'), { CANDLESCAN_KV: kv });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('X-Cache')).toBe('MISS');
    expect(resp.headers.get('X-Cache-Source')).toBe('miss');
    const body = await resp.json();
    expect(body.count).toBe(1);
  });

  it('HIT on second call uses cache (no second upstream fetch)', async () => {
    const fetchMock = vi.fn(async () => new Response(
      '<rss><channel><item><title>TCS results</title></item></channel></rss>',
      { status: 200 },
    ));
    globalThis.fetch = fetchMock;
    const kv = makeKvStub();
    await worker.fetch(makeRequest('/news/google?symbol=TCS'), { CANDLESCAN_KV: kv });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const resp2 = await worker.fetch(makeRequest('/news/google?symbol=TCS'), { CANDLESCAN_KV: kv });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resp2.headers.get('X-Cache')).toBe('HIT');
    expect(resp2.headers.get('X-Cache-Source')).toBe('fresh');
  });

  it('STALE fallback when upstream 502s + cache exists', async () => {
    const kv = makeKvStub();
    const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    const key = `google_news:INFY:${today}`;
    // 5h-old entry: past 4h TTL, within 24h staleMax
    kv.store.set(key, JSON.stringify({
      value: { symbol: 'INFY', items: [{ title: 'Infy Q4' }], count: 1 },
      writtenAt: Date.now() - 5 * 60 * 60 * 1000,
    }));
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 502 }));
    const resp = await worker.fetch(makeRequest('/news/google?symbol=INFY'), { CANDLESCAN_KV: kv });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('X-Cache')).toBe('STALE');
    expect(resp.headers.get('X-Cache-Source')).toBe('stale');
    const body = await resp.json();
    expect(body.items[0].title).toBe('Infy Q4');
  });

  it('UNAVAILABLE sentinel (HTTP 200) when upstream fails + no cache', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 502 }));
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/news/google?symbol=NONEXIST'), { CANDLESCAN_KV: kv });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('X-Cache')).toBe('UNAVAILABLE');
    expect(resp.headers.get('X-Cache-Source')).toBe('unavailable');
    const body = await resp.json();
    expect(body.source).toBe('unavailable');
    expect(body.items).toEqual([]);
    expect(body.score).toBeNull();
  });

  it('exposes X-Cache* headers via Access-Control-Expose-Headers', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<rss></rss>', { status: 200 }));
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/news/google?symbol=INFY'), { CANDLESCAN_KV: kv });
    const expose = resp.headers.get('Access-Control-Expose-Headers') || '';
    expect(expose).toContain('X-Cache');
    expect(expose).toContain('X-Cache-Age');
    expect(expose).toContain('X-Cache-Key');
    expect(expose).toContain('X-Cache-Source');
  });

  it('extracts <link> from Google RSS items', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      '<rss><channel><item><title>HDFC up 3%</title><description>Rally</description><link>https://news.google.com/rss/articles/abc123</link></item></channel></rss>',
      { status: 200 },
    ));
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/news/google?symbol=HDFC'), { CANDLESCAN_KV: kv });
    const body = await resp.json();
    expect(body.items[0].link).toBe('https://news.google.com/rss/articles/abc123');
  });
});

describe('handleIndiaNews — link extraction', () => {
  it('extracts <link> from broad-feed RSS items', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      '<rss><channel><item><title>RELIANCE up</title><description>Q4 strong</description><link>https://www.moneycontrol.com/news/business/reliance-q4-12345.html</link></item></channel></rss>',
      { status: 200 },
    ));
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/news/india'), { CANDLESCAN_KV: kv });
    const body = await resp.json();
    expect(body.items[0].link).toBe('https://www.moneycontrol.com/news/business/reliance-q4-12345.html');
  });
});

// ───────────────────────────────────────────────────────────
// Write-budget micro-cache
// ───────────────────────────────────────────────────────────
describe('write-dedupe micro-cache', () => {
  it('does not write twice for two near-simultaneous /news/google cache misses on the same symbol', async () => {
    // Two concurrent requests for the same symbol — first writes,
    // second is still in the 30s dedupe window → should skip.
    const kv = makeKvStub();
    let fetchCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCount++;
      return new Response('<rss><channel><item><title>X</title></item></channel></rss>', { status: 200 });
    });

    await worker.fetch(makeRequest('/news/google?symbol=HDFCBANK'), { CANDLESCAN_KV: kv });
    // Manually clear KV so the next call counts as a miss again BUT dedupe
    // map still says "we wrote this key 0s ago".
    kv.store.clear();
    await worker.fetch(makeRequest('/news/google?symbol=HDFCBANK'), { CANDLESCAN_KV: kv });

    // Only 1 KV write should have happened — the second miss was deduped.
    expect(kv.writeCount()).toBe(1);
    // Both requests still fetched upstream (they're cache misses)
    expect(fetchCount).toBe(2);
  });
});
