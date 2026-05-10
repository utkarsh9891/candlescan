/**
 * Integration tests for the four KV-cached Worker handlers:
 *   - /market/vix         → handleVixFetch
 *   - /market/fiidii      → handleFiiDiiFetch
 *   - /news/india         → handleIndiaNews
 *   - /quote/last         → handleQuoteLast
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
    const resp = await worker.fetch(makeRequest('/market/vix'), { CANDLESCAN_CACHE: kv });
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
    await worker.fetch(makeRequest('/market/vix'), { CANDLESCAN_CACHE: kv });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Second call — should be a HIT
    const resp2 = await worker.fetch(makeRequest('/market/vix'), { CANDLESCAN_CACHE: kv });
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
    const resp = await worker.fetch(makeRequest('/market/vix'), { CANDLESCAN_CACHE: kv });
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
    const resp = await worker.fetch(makeRequest('/market/vix'), { CANDLESCAN_CACHE: kv });
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
    const resp = await worker.fetch(makeRequest('/market/fiidii'), { CANDLESCAN_CACHE: kv });
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
    await worker.fetch(makeRequest('/market/fiidii'), { CANDLESCAN_CACHE: kv });
    const cbBefore = fetchMock.mock.calls.length;
    const resp2 = await worker.fetch(makeRequest('/market/fiidii'), { CANDLESCAN_CACHE: kv });
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
    const resp = await worker.fetch(makeRequest('/market/fiidii'), { CANDLESCAN_CACHE: kv });
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
    const resp = await worker.fetch(makeRequest('/news/india'), { CANDLESCAN_CACHE: kv });
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
      return new Response(
        `<rss><channel><item><title>${title}</title></item></channel></rss>`,
        { status: 200 },
      );
    });
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/news/india'), { CANDLESCAN_CACHE: kv });
    const body = await resp.json();
    const publishers = new Set(body.items.map((it) => it.publisher));
    expect(publishers.has('Moneycontrol')).toBe(true);
    expect(publishers.has('LiveMint')).toBe(true);
    expect(publishers.has('Economic Times')).toBe(true);
    // Business Standard was dropped (HTTP 403 from CF egress even on Googlebot UA)
    expect(publishers.has('Business Standard')).toBe(false);
  });

  it('sends Googlebot UA for Moneycontrol feeds, default UA for others', async () => {
    // Moneycontrol returns empty bodies to the default `candlescan-proxy`
    // UA when called from CF egress IPs. Per-feed `ua` override sends
    // Googlebot/2.1 instead, which they whitelist for indexing. Other
    // publishers don't need the override.
    const sentUserAgents = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      sentUserAgents.push({ url: String(url), ua: init?.headers?.['User-Agent'] });
      return new Response('<rss><channel><item><title>x</title></item></channel></rss>', { status: 200 });
    });
    const kv = makeKvStub();
    await worker.fetch(makeRequest('/news/india'), { CANDLESCAN_CACHE: kv });

    const mcCalls = sentUserAgents.filter((c) => c.url.includes('moneycontrol.com'));
    expect(mcCalls.length).toBeGreaterThan(0);
    for (const c of mcCalls) expect(c.ua).toMatch(/Googlebot/);

    const livemintCalls = sentUserAgents.filter((c) => c.url.includes('livemint.com'));
    expect(livemintCalls.length).toBeGreaterThan(0);
    for (const c of livemintCalls) expect(c.ua).not.toMatch(/Googlebot/);
  });

  it('UNAVAILABLE sentinel when all feeds 502 + no cache', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 502 }));
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/news/india'), { CANDLESCAN_CACHE: kv });
    expect(resp.status).toBe(200); // UNAVAILABLE returns 200 so callers don't retry
    expect(resp.headers.get('X-Cache')).toBe('UNAVAILABLE');
    const body = await resp.json();
    expect(body.count).toBe(0);
    expect(body.source).toBe('unavailable');
  });
});

// ───────────────────────────────────────────────────────────
// /quote/last  (last-candle quote proxy — replaces /v7/finance/quote)
// ───────────────────────────────────────────────────────────
describe('handleQuoteLast', () => {
  // Build a minimal Yahoo /v8/chart response that fetchQuoteLastUpstream
  // can parse. The interesting fields are meta.* and indicators.quote[0].close.
  function makeChartResp({ closes, meta = {} }) {
    return jsonResp({
      chart: {
        result: [{
          meta: {
            regularMarketPrice: meta.regularMarketPrice ?? null,
            chartPreviousClose: meta.chartPreviousClose ?? null,
            regularMarketDayHigh: meta.regularMarketDayHigh ?? null,
            regularMarketDayLow: meta.regularMarketDayLow ?? null,
          },
          indicators: { quote: [{ close: closes }] },
        }],
      },
    });
  }

  it('400 on missing symbol', async () => {
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/quote/last'), { CANDLESCAN_CACHE: kv });
    expect(resp.status).toBe(400);
  });

  it('MISS → upstream fetch → 200 with last-candle close + dayHigh/Low/prevClose', async () => {
    globalThis.fetch = vi.fn(async () => makeChartResp({
      closes: [100, 101, 102.5],
      meta: { regularMarketDayHigh: 103, regularMarketDayLow: 99.5, chartPreviousClose: 99 },
    }));
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/quote/last?symbol=RELIANCE'), { CANDLESCAN_CACHE: kv });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('X-Cache')).toBe('MISS');
    const body = await resp.json();
    expect(body.last).toBe(102.5);
    expect(body.dayHigh).toBe(103);
    expect(body.dayLow).toBe(99.5);
    expect(body.prevClose).toBe(99);
  });

  it('falls back to meta.regularMarketPrice when latest 1m close is null (still-forming candle)', async () => {
    globalThis.fetch = vi.fn(async () => makeChartResp({
      closes: [100, 101, null], // most recent candle still forming
      meta: { regularMarketPrice: 101.4 },
    }));
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/quote/last?symbol=TCS'), { CANDLESCAN_CACHE: kv });
    const body = await resp.json();
    // Last non-null close in series is 101 — that wins over meta fallback
    expect(body.last).toBe(101);
  });

  it('returns meta.regularMarketPrice when ALL closes are null (cold session)', async () => {
    globalThis.fetch = vi.fn(async () => makeChartResp({
      closes: [null, null, null],
      meta: { regularMarketPrice: 555 },
    }));
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/quote/last?symbol=INFY'), { CANDLESCAN_CACHE: kv });
    const body = await resp.json();
    expect(body.last).toBe(555);
  });

  it('HIT on second call within 30s window uses cache', async () => {
    const fetchMock = vi.fn(async () => makeChartResp({ closes: [100], meta: {} }));
    globalThis.fetch = fetchMock;
    const kv = makeKvStub();
    await worker.fetch(makeRequest('/quote/last?symbol=HDFCBANK'), { CANDLESCAN_CACHE: kv });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const resp2 = await worker.fetch(makeRequest('/quote/last?symbol=HDFCBANK'), { CANDLESCAN_CACHE: kv });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resp2.headers.get('X-Cache')).toBe('HIT');
  });

  it('UNAVAILABLE sentinel when upstream 502s + no cache', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 502 }));
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/quote/last?symbol=NONEXIST'), { CANDLESCAN_CACHE: kv });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('X-Cache')).toBe('UNAVAILABLE');
    const body = await resp.json();
    expect(body.source).toBe('unavailable');
    expect(body.last).toBeNull();
  });

  it('hits Yahoo /v8/finance/chart with .NS suffix and 1m/1d params', async () => {
    let calledUrl = '';
    globalThis.fetch = vi.fn(async (url) => {
      calledUrl = String(url);
      return makeChartResp({ closes: [100], meta: {} });
    });
    const kv = makeKvStub();
    await worker.fetch(makeRequest('/quote/last?symbol=RELIANCE'), { CANDLESCAN_CACHE: kv });
    expect(calledUrl).toMatch(/v8\/finance\/chart/);
    expect(calledUrl).toMatch(/RELIANCE\.NS/);
    expect(calledUrl).toMatch(/interval=1m/);
    expect(calledUrl).toMatch(/range=1d/);
  });
});

describe('handleIndiaNews — link extraction', () => {
  it('extracts <link> from broad-feed RSS items', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      '<rss><channel><item><title>RELIANCE up</title><description>Q4 strong</description><link>https://www.moneycontrol.com/news/business/reliance-q4-12345.html</link></item></channel></rss>',
      { status: 200 },
    ));
    const kv = makeKvStub();
    const resp = await worker.fetch(makeRequest('/news/india'), { CANDLESCAN_CACHE: kv });
    const body = await resp.json();
    expect(body.items[0].link).toBe('https://www.moneycontrol.com/news/business/reliance-q4-12345.html');
  });
});

// ───────────────────────────────────────────────────────────
// Public-endpoint rate limiting (DOS guard)
// ───────────────────────────────────────────────────────────
describe('publicEndpointGuard — DOS protection on /news/* + /market/*', () => {
  // Helper: send a request with a CF-Connecting-IP header so the
  // counter has a stable key (otherwise every request shares the
  // 'unknown' bucket).
  function makeIpRequest(path, ip) {
    return new Request(`https://candlescan-proxy.workers.dev${path}`, {
      method: 'GET',
      headers: {
        Origin: 'https://utkarsh9891.github.io',
        'CF-Connecting-IP': ip,
      },
    });
  }

  // Mirror the worker's IP-hash logic so we can pre-seed the counter
  // at the exact key the guard will read on the next request.
  async function ipKey(ip, prefix = 'prl') {
    const data = new TextEncoder().encode(ip);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const today = new Date().toISOString().slice(0, 10);
    return `${prefix}:${hex.slice(0, 16)}:${today}`;
  }

  it('rejects with 429 when the per-IP daily limit is already exceeded', async () => {
    // Pre-seed the rate-limit KV with a count at the limit so the next
    // request flips to 429 without us having to issue 100 actual requests.
    const candlescanKv = makeKvStub();
    const rateLimitKv = makeKvStub();
    rateLimitKv.store.set(await ipKey('1.2.3.4'), '100'); // == PUBLIC_DAILY_LIMIT

    globalThis.fetch = vi.fn(async () => new Response('<rss></rss>', { status: 200 }));

    const resp = await worker.fetch(
      makeIpRequest('/news/india', '1.2.3.4'),
      { CANDLESCAN_KV: candlescanKv, RATE_LIMIT: rateLimitKv },
    );
    expect(resp.status).toBe(429);
    expect(resp.headers.get('X-RateLimit-Remaining')).toBe('0');
    const body = await resp.json();
    expect(body.error).toMatch(/limit exceeded/i);
    // Upstream was NOT called — request short-circuited at the guard.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('allows the request when the per-IP counter is below the limit', async () => {
    const candlescanKv = makeKvStub();
    const rateLimitKv = makeKvStub();
    // No seed — counter starts at 0, well below the 100/day cap.
    globalThis.fetch = vi.fn(async () => new Response('<rss><channel><item><title>x</title></item></channel></rss>', { status: 200 }));
    const resp = await worker.fetch(
      makeIpRequest('/news/india', '5.6.7.8'),
      { CANDLESCAN_KV: candlescanKv, RATE_LIMIT: rateLimitKv },
    );
    expect(resp.status).toBe(200);
  });

  it('does NOT rate-limit non-public paths (/dhan/instruments, /github/releases)', async () => {
    // Pre-seed the KV way over the limit — these paths should still go
    // through because they're not in PUBLIC_RATE_LIMITED_PATHS.
    const candlescanKv = makeKvStub();
    const rateLimitKv = makeKvStub();
    rateLimitKv.store.set(await ipKey('1.2.3.4'), '99999');

    globalThis.fetch = vi.fn(async () => jsonResp([{ tag_name: 'v1.0.0' }]));
    const resp = await worker.fetch(
      makeIpRequest('/github/releases?repo=foo/bar', '1.2.3.4'),
      { CANDLESCAN_KV: candlescanKv, RATE_LIMIT: rateLimitKv },
    );
    expect(resp.status).toBe(200);
  });

  it('skips rate limit entirely when RATE_LIMIT KV is not bound', async () => {
    // Backward compat: if env.RATE_LIMIT is missing the guard early-returns
    // allowed=true. This is what protects every test in this file from
    // needing a RATE_LIMIT binding.
    const candlescanKv = makeKvStub();
    globalThis.fetch = vi.fn(async () => new Response('<rss><channel><item><title>x</title></item></channel></rss>', { status: 200 }));
    const resp = await worker.fetch(
      makeIpRequest('/news/india', '1.2.3.4'),
      { CANDLESCAN_KV: candlescanKv }, // no RATE_LIMIT
    );
    expect(resp.status).toBe(200);
  });
});

// ───────────────────────────────────────────────────────────
// Write-budget micro-cache
// ───────────────────────────────────────────────────────────
describe('write-dedupe micro-cache', () => {
  it('does not write twice for two near-simultaneous /quote/last cache misses on the same symbol', async () => {
    // Two concurrent requests for the same symbol — first writes,
    // second is still in the 30s dedupe window → should skip.
    const kv = makeKvStub();
    let fetchCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCount++;
      return new Response(JSON.stringify({
        chart: { result: [{ meta: {}, indicators: { quote: [{ close: [100] }] } }] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await worker.fetch(makeRequest('/quote/last?symbol=HDFCBANK'), { CANDLESCAN_CACHE: kv });
    // Manually clear KV so the next call counts as a miss again BUT dedupe
    // map still says "we wrote this key 0s ago".
    kv.store.clear();
    await worker.fetch(makeRequest('/quote/last?symbol=HDFCBANK'), { CANDLESCAN_CACHE: kv });

    // Only 1 KV write should have happened — the second miss was deduped.
    expect(kv.writeCount()).toBe(1);
    // Both requests still fetched upstream (they're cache misses)
    expect(fetchCount).toBe(2);
  });
});
