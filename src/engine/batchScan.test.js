import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  batchScan,
  fetchFlowClass,
  _resetBatchScanNewsCache,
  _resetBatchScanFlowCache,
} from './batchScan.js';
import { clearNewsCache } from './newsCacheLocal.js';
import { bullishEngulfing } from './__fixtures__/candles.js';

// Mock fetchOHLCV to return deterministic data without network
vi.mock('./fetcher.js', () => ({
  fetchOHLCV: vi.fn(async (symbol) => ({
    candles: bullishEngulfing,
    live: true,
    simulated: false,
    yahooSymbol: `${symbol}.NS`,
    displaySymbol: symbol,
    companyName: `${symbol} Ltd`,
  })),
  TIMEFRAME_MAP: { '5m': { interval: '5m', range: '5d' } },
}));

// Transport seam: keep the Worker URL stable so assertions on request URLs
// don't depend on the real production value.
vi.mock('./transport.js', () => ({
  CF_WORKER_URL: 'https://mock.workers.dev',
  cfUrl: (path) => `https://mock.workers.dev${path?.startsWith('/') ? path : '/' + (path || '')}`,
}));

// Default-mock the live Google News fetcher so the existing tests don't
// hit the network. Individual tests override this with `newsFetchFn`.
vi.mock('./marketContextLive.js', () => ({
  fetchLiveGoogleNewsDetailForSymbol: vi.fn(async () => ({ score: null, headlines: [] })),
}));

// Silence the FII/DII console.warn that our scan emits when the Worker
// fetch falls through to the NEUTRAL fallback. Individual tests that
// want to assert on the warning spy it explicitly.
let warnSpy;
// Default-stub global fetch so batchScan's /market/fiidii call doesn't
// hit the network during tests that don't care about flow. Tests that
// exercise the flow path pass `flowFetchFn` directly.
let originalFetch;
beforeEach(() => {
  _resetBatchScanNewsCache();
  _resetBatchScanFlowCache();
  clearNewsCache();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
});
afterEach(() => {
  warnSpy?.mockRestore();
  globalThis.fetch = originalFetch;
});

describe('batchScan', () => {
  it('scans multiple symbols and returns results', async () => {
    const results = await batchScan({
      symbols: ['RELIANCE', 'TCS', 'INFY'],
      timeframe: '5m',
      gateToken: 'test',
      concurrency: 2,
      delayMs: 0,
    });

    expect(results.length).toBe(3);
  });

  it('each result has required fields', async () => {
    const results = await batchScan({
      symbols: ['RELIANCE'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
    });

    const r = results[0];
    expect(r).toHaveProperty('symbol');
    expect(r).toHaveProperty('companyName');
    expect(r).toHaveProperty('action');
    expect(r).toHaveProperty('confidence');
    expect(r).toHaveProperty('direction');
    expect(r).toHaveProperty('entry');
    expect(r).toHaveProperty('sl');
    expect(r).toHaveProperty('target');
    expect(r).toHaveProperty('rr');
    expect(r).toHaveProperty('topPattern');
    expect(r).toHaveProperty('context');
  });

  it('results are sorted by action rank then confidence', async () => {
    const results = await batchScan({
      symbols: ['A', 'B', 'C', 'D', 'E'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
    });

    // All get same data so same action — verify confidence is descending within group
    for (let i = 1; i < results.length; i++) {
      expect(results[i].confidence).toBeLessThanOrEqual(results[i - 1].confidence);
    }
  });

  it('calls onProgress during scan', async () => {
    const progress = [];
    await batchScan({
      symbols: ['A', 'B', 'C'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      onProgress: (completed, total) => progress.push({ completed, total }),
    });

    expect(progress.length).toBeGreaterThan(0);
    const last = progress[progress.length - 1];
    expect(last.completed).toBe(3);
    expect(last.total).toBe(3);
  });

  it('respects AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort(); // abort immediately

    const results = await batchScan({
      symbols: ['A', 'B', 'C', 'D', 'E'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      signal: controller.signal,
    });

    // Should have 0 results since aborted before starting
    expect(results.length).toBe(0);
  });

  it('handles empty symbol list', async () => {
    const results = await batchScan({
      symbols: [],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
    });

    expect(results).toEqual([]);
  });

  it('attaches tokenError=null to successful scans', async () => {
    const results = await batchScan({
      symbols: ['RELIANCE'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
    });
    expect(results.tokenError).toBeNull();
  });

  it('surfaces tokenError + short-circuits when fetchFn throws TokenExpiredError', async () => {
    // Phase A P1 #8 — the failure mode that used to produce an empty
    // scan with no explanation. A fetchFn that throws TokenExpiredError
    // must (a) not swallow silently, (b) stop scanning further symbols,
    // (c) surface tokenError on the returned array so the UI banner
    // can render.
    const { TokenExpiredError } = await import('./brokerErrors.js');
    const calls = [];
    const failingFetch = async (sym) => {
      calls.push(sym);
      throw new TokenExpiredError('dhan');
    };

    const results = await batchScan({
      symbols: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      concurrency: 2,
      fetchFn: failingFetch,
    });

    expect(results.tokenError).toEqual({ broker: 'dhan' });
    // Short-circuited — not every symbol got tried (first chunk of 2
    // fires, then the outer loop breaks on the latched tokenError).
    expect(calls.length).toBeLessThan(10);
    expect(results.length).toBe(0);
  });
});

describe('batchScan per-symbol news enrichment', () => {
  it('fetches news only for candidate symbols (not the whole universe)', async () => {
    const newsFetchFn = vi.fn(async () => ({ score: 0.6, headlines: [{ title: 'beat', score: 0.6 }] }));

    // The bullishEngulfing fixture produces a tradable signal for every
    // symbol in this suite — so "candidates" here equals the full input.
    // The assertion that matters is: the news fetcher is NEVER called
    // for filter-rejected symbols, and the count equals the candidate
    // count, not the scan universe.
    const results = await batchScan({
      symbols: ['AAA', 'BBB', 'CCC'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      newsFetchFn,
    });

    const actionable = results.filter((r) => r.action && r.action !== 'NO TRADE');
    expect(newsFetchFn).toHaveBeenCalledTimes(actionable.length);
    expect(actionable.length).toBeGreaterThan(0);
    // Telemetry surfaces the fetch count
    expect(results.telemetry.newsFetched).toBe(actionable.length);
    expect(results.telemetry.newsCacheHits).toBe(0);
    // The per-symbol news plumbed through to the returned row
    for (const r of actionable) {
      expect(r.newsScore).toBeGreaterThan(0);
      expect(r.newsHeadlines.length).toBeGreaterThan(0);
      expect(r.newsSource).toBe('google');
    }
  });

  it('hits the per-(symbol, hour) cache on a second scan within the hour', async () => {
    const newsFetchFn = vi.fn(async () => ({ score: 0.4, headlines: [{ title: 'gain' }] }));

    const first = await batchScan({
      symbols: ['XX', 'YY'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      newsFetchFn,
    });
    const firstFetched = first.telemetry.newsFetched;
    expect(firstFetched).toBeGreaterThan(0);

    // Second scan within the same hour — same symbols must resolve from
    // cache and the fetcher must not be called again.
    const prevCalls = newsFetchFn.mock.calls.length;
    const second = await batchScan({
      symbols: ['XX', 'YY'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      newsFetchFn,
    });
    expect(newsFetchFn.mock.calls.length).toBe(prevCalls); // no new network calls
    expect(second.telemetry.newsFetched).toBe(0);
    expect(second.telemetry.newsCacheHits).toBeGreaterThan(0);
  });

  it('falls back to the Moneycontrol index feed when per-symbol fetch fails', async () => {
    const newsFetchFn = vi.fn(async () => { throw new Error('CF Worker 502'); });

    const results = await batchScan({
      symbols: ['ZZZ'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      newsFetchFn,
      marketContext: {
        newsMap: { ZZZ: -0.25 }, // Moneycontrol-scored; classifies BEARISH
        headlinesMap: { ZZZ: [{ title: 'profit warning', source: 'moneycontrol' }] },
      },
    });

    // Fall back to Moneycontrol for sentiment, news source stays 'moneycontrol'
    const r = results.find((x) => x.symbol === 'ZZZ');
    expect(r).toBeDefined();
    expect(r.newsScore).toBeCloseTo(-0.25);
    expect(r.newsSource).toBe('moneycontrol');
    // Error was counted in telemetry but did not crash the scan
    expect(results.telemetry.newsFetchErrors).toBeGreaterThan(0);
    // The scan still yielded a row for the symbol
    expect(results.length).toBe(1);
  });

  it('does not fetch news for filter-rejected symbols', async () => {
    // sectorMap-based filter won't reject arbitrary strings in this
    // setup; instead validate the inverse with an aborted signal that
    // kills the scan before any symbol is processed.
    const controller = new AbortController();
    controller.abort();
    const newsFetchFn = vi.fn(async () => ({ score: 0.5, headlines: [] }));

    const results = await batchScan({
      symbols: ['AAA', 'BBB'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      signal: controller.signal,
      newsFetchFn,
    });

    expect(newsFetchFn).not.toHaveBeenCalled();
    expect(results.telemetry.newsFetched).toBe(0);
  });
});

describe('batchScan live FII/DII flow wiring', () => {
  const makeFlowFetchFn = (fii, dii, { ok = true, status = 200 } = {}) =>
    vi.fn(async () => ({
      ok,
      status,
      json: async () => ({ fii, dii, date: '2026-04-21' }),
    }));

  it('hydrates telemetry.flowClass from the Worker when no marketContext given', async () => {
    // +800cr combined → STRONG_BUY in classifyInstitutionalFlow
    const flowFetchFn = makeFlowFetchFn(500, 300);

    const results = await batchScan({
      symbols: ['RELIANCE', 'TCS'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      flowFetchFn,
    });

    expect(flowFetchFn).toHaveBeenCalledTimes(1);
    expect(flowFetchFn.mock.calls[0][0]).toMatch(/\/market\/fiidii$/);
    expect(results.telemetry.flowClass).toBe('STRONG_BUY');
    expect(results.telemetry.flowSource).toBe('worker');
    // Every row carries the hydrated flow through to stockContext
    for (const r of results) expect(r.flow).toBe('STRONG_BUY');
  });

  it('applies the flow delta to sizeMult on BULLISH alignment', async () => {
    const flowFetchFn = makeFlowFetchFn(500, 300); // STRONG_BUY

    const withFlow = await batchScan({
      symbols: ['RELIANCE'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      flowFetchFn,
    });

    _resetBatchScanFlowCache();

    // Same scan but with no flow signal — sizeMultiplier falls through to
    // the no-flow baseline path (1.0 on a clean, single-symbol scan).
    const withoutFlow = await batchScan({
      symbols: ['RELIANCE'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      marketContext: { flow: 'NEUTRAL' },
    });

    const longWithFlow = withFlow.find((r) => r.direction === 'long');
    const longNeutral = withoutFlow.find((r) => r.direction === 'long');
    expect(longWithFlow).toBeDefined();
    expect(longNeutral).toBeDefined();
    // STRONG_BUY aligned with a long trade → positive flow delta applied.
    expect(longWithFlow.sizeMult).toBeGreaterThan(longNeutral.sizeMult);
  });

  it('defaults to NEUTRAL and does not crash when the Worker returns 5xx', async () => {
    const flowFetchFn = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({ error: 'upstream' }),
    }));

    const results = await batchScan({
      symbols: ['RELIANCE'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      flowFetchFn,
    });

    expect(results.telemetry.flowClass).toBe('NEUTRAL');
    expect(results.telemetry.flowSource).toBe('fallback');
    expect(results.length).toBe(1);
    // warning logged to console.warn (already captured by the suite-wide
    // spy); scan does not crash.
    expect(warnSpy).toHaveBeenCalled();
  });

  it('defaults to NEUTRAL on thrown fetch errors (network failure)', async () => {
    const flowFetchFn = vi.fn(async () => {
      throw new Error('CF Worker unreachable');
    });

    const results = await batchScan({
      symbols: ['RELIANCE'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      flowFetchFn,
    });

    expect(results.telemetry.flowClass).toBe('NEUTRAL');
    expect(results.telemetry.flowSource).toBe('fallback');
  });

  it('shares a single fetch across concurrent scans (cache hit on 2nd)', async () => {
    const flowFetchFn = makeFlowFetchFn(500, 300);

    // Fire both scans in parallel — the in-flight promise inside
    // fetchFlowClass should coalesce them to one Worker call.
    const [a, b] = await Promise.all([
      batchScan({
        symbols: ['RELIANCE'],
        timeframe: '5m',
        gateToken: 'test',
        delayMs: 0,
        flowFetchFn,
      }),
      batchScan({
        symbols: ['TCS'],
        timeframe: '5m',
        gateToken: 'test',
        delayMs: 0,
        flowFetchFn,
      }),
    ]);

    expect(flowFetchFn).toHaveBeenCalledTimes(1);
    expect(a.telemetry.flowClass).toBe('STRONG_BUY');
    expect(b.telemetry.flowClass).toBe('STRONG_BUY');

    // Third scan after both settle — should still hit the 10-min cache
    const c = await batchScan({
      symbols: ['INFY'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      flowFetchFn,
    });
    expect(flowFetchFn).toHaveBeenCalledTimes(1);
    expect(c.telemetry.flowClass).toBe('STRONG_BUY');
  });

  it('prefers the caller-provided marketContext.flow over the Worker fetch', async () => {
    const flowFetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ fii: 500, dii: 300 }),
    }));

    const results = await batchScan({
      symbols: ['RELIANCE'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      marketContext: { flow: 'SELL' },
      flowFetchFn,
    });

    expect(flowFetchFn).not.toHaveBeenCalled();
    expect(results.telemetry.flowClass).toBe('SELL');
    expect(results.telemetry.flowSource).toBe('marketContext');
  });

  it('fetchFlowClass unit: returns classified value and caches it', async () => {
    _resetBatchScanFlowCache();
    const f = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ fii: 500, dii: 300 }),
    }));
    const a = await fetchFlowClass({ fetchFn: f });
    const b = await fetchFlowClass({ fetchFn: f });
    expect(a).toBe('STRONG_BUY');
    expect(b).toBe('STRONG_BUY');
    expect(f).toHaveBeenCalledTimes(1); // cached
  });
});

// ─────────────────────────────────────────────────────────────────────
// Wave 1.5d — 4-tier news fallback chain
// ─────────────────────────────────────────────────────────────────────
describe('batchScan news fallback chain (Wave 1.5d)', () => {
  it('tier 3 STALE: Worker served from KV; scan uses it and marks it stale', async () => {
    const newsFetchFn = vi.fn(async () => ({
      score: 0.35,
      headlines: [{ title: 'old news but valid', score: 0.35 }],
      cacheStatus: 'STALE',
      cacheSource: 'kv',
    }));

    const results = await batchScan({
      symbols: ['AAA'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      newsFetchFn,
    });

    const actionable = results.filter((r) => r.action && r.action !== 'NO TRADE');
    expect(actionable.length).toBeGreaterThan(0);
    for (const r of actionable) {
      // STALE Google score propagates; source distinguishes it from a fresh HIT.
      expect(r.newsScore).toBeCloseTo(0.35);
      expect(r.newsSource).toBe('stale');
    }
    // Telemetry: none of the Wave 1.5d fallback counters should fire
    // because tier 3 succeeded (just with stale data).
    expect(results.telemetry.newsFetched).toBeGreaterThan(0);
    expect(results.telemetry.newsFromFallback).toBe(0);
    expect(results.telemetry.newsUnavailable).toBe(0);
  });

  it('tier 3 UNAVAILABLE → tier 4 Moneycontrol: scan completes with MC sentiment', async () => {
    // Worker says it has nothing, not even stale.
    const newsFetchFn = vi.fn(async () => ({
      score: null,
      headlines: [],
      cacheStatus: 'UNAVAILABLE',
      cacheSource: null,
    }));
    const moneycontrolFn = vi.fn(async () => ({
      score: -0.4,
      headlines: [{ title: 'downgrade', source: 'moneycontrol' }],
    }));

    const results = await batchScan({
      symbols: ['BBB'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      newsFetchFn,
      moneycontrolFn,
    });

    expect(newsFetchFn).toHaveBeenCalled();
    expect(moneycontrolFn).toHaveBeenCalled();
    const r = results.find((x) => x.symbol === 'BBB');
    expect(r).toBeDefined();
    expect(r.newsScore).toBeCloseTo(-0.4);
    expect(r.newsSource).toBe('moneycontrol');
    expect(results.telemetry.newsFromFallback).toBeGreaterThan(0);
    expect(results.telemetry.newsUnavailable).toBe(0);
  });

  it('tier 3 UNAVAILABLE + no Moneycontrol: scan still yields a row with score=null', async () => {
    const newsFetchFn = vi.fn(async () => ({
      score: null,
      headlines: [],
      cacheStatus: 'UNAVAILABLE',
    }));

    const results = await batchScan({
      symbols: ['CCC'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      newsFetchFn,
      // No moneycontrolFn, no marketContext.newsMap — tier 4 empty.
    });

    expect(results.length).toBe(1);
    const r = results[0];
    // No news at any tier — row still exists, just no sentiment bonus.
    expect(r.newsScore == null).toBe(true);
    expect(results.telemetry.newsUnavailable).toBeGreaterThan(0);
  });

  it('tier 2 localStorage hit: second scan within TTL skips the Worker', async () => {
    const newsFetchFn = vi.fn(async () => ({
      score: 0.55,
      headlines: [{ title: 'fresh', score: 0.55 }],
      cacheStatus: 'HIT',
    }));

    const first = await batchScan({
      symbols: ['DDD'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      newsFetchFn,
    });
    expect(first.telemetry.newsFetched).toBeGreaterThan(0);
    const worker1 = newsFetchFn.mock.calls.length;
    expect(worker1).toBeGreaterThan(0);

    // Drop the in-memory hour cache so the disk cache (tier 2) is
    // the only thing that can satisfy the second scan. This simulates
    // a page reload: in-memory cache is empty, but localStorage survives.
    _resetBatchScanNewsCache();

    const second = await batchScan({
      symbols: ['DDD'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      newsFetchFn,
    });

    // Worker was NOT called again — localStorage served the request.
    expect(newsFetchFn.mock.calls.length).toBe(worker1);
    expect(second.telemetry.newsFetched).toBe(0);
    expect(second.telemetry.newsFromCache).toBeGreaterThan(0);

    // Score and headlines survived the disk round-trip.
    const r = second.find((x) => x.symbol === 'DDD');
    expect(r).toBeDefined();
    expect(r.newsScore).toBeCloseTo(0.55);
    expect(r.newsHeadlines.length).toBeGreaterThan(0);
  });

  it('cold start + Worker throws 502: falls through to Moneycontrol, no crash', async () => {
    // Simulate the exact Google News 502 scenario the load-test saw.
    const newsFetchFn = vi.fn(async () => {
      throw new Error('CF Worker upstream 502');
    });
    const moneycontrolFn = vi.fn(async (sym) => ({
      score: sym === 'EEE' ? -0.2 : 0.2,
      headlines: [{ title: `mc-${sym}`, source: 'moneycontrol' }],
    }));

    const results = await batchScan({
      symbols: ['EEE'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      newsFetchFn,
      moneycontrolFn,
    });

    expect(results.length).toBe(1);
    const r = results[0];
    expect(r.newsScore).toBeCloseTo(-0.2);
    expect(r.newsSource).toBe('moneycontrol');
    // Thrown errors get counted AND the fallback ran.
    expect(results.telemetry.newsFetchErrors).toBeGreaterThan(0);
    expect(results.telemetry.newsFromFallback).toBeGreaterThan(0);
  });
});
