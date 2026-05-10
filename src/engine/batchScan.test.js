import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  batchScan,
  fetchFlowClass,
  _resetBatchScanFlowCache,
} from './batchScan.js';
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

// Silence the FII/DII console.warn that our scan emits when the Worker
// fetch falls through to the NEUTRAL fallback. Individual tests that
// want to assert on the warning spy it explicitly.
let warnSpy;
// Default-stub global fetch so batchScan's /market/fiidii call doesn't
// hit the network during tests that don't care about flow. Tests that
// exercise the flow path pass `flowFetchFn` directly.
let originalFetch;
beforeEach(() => {
  _resetBatchScanFlowCache();
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

describe('batchScan news (single-tier broad-feed map)', () => {
  // After the Google tier-3 drop, news is single-tier: marketContext.newsMap
  // is the only source. Per candidate we either resolve from that map
  // (newsResolved++) or have nothing to attach (newsUnavailable++).
  it('resolves news from the index-wide broad-feed map for candidates that match', async () => {
    const results = await batchScan({
      symbols: ['ZZZ'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      marketContext: {
        newsMap: { ZZZ: -0.25 }, // BEARISH
        headlinesMap: { ZZZ: [{ title: 'profit warning', source: 'india' }] },
      },
    });

    const r = results.find((x) => x.symbol === 'ZZZ');
    expect(r).toBeDefined();
    expect(r.newsScore).toBeCloseTo(-0.25);
    expect(r.newsSource).toBe('india');
    expect(r.newsHeadlines).toHaveLength(1);
    expect(results.telemetry.newsResolved).toBeGreaterThan(0);
    expect(results.telemetry.newsUnavailable).toBe(0);
  });

  it('counts unavailable when the symbol is missing from the broad-feed map', async () => {
    const results = await batchScan({
      symbols: ['NOMATCH'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      marketContext: {
        newsMap: {}, // empty — no symbol mentioned
        headlinesMap: {},
      },
    });

    const r = results.find((x) => x.symbol === 'NOMATCH');
    expect(r).toBeDefined();
    expect(r.newsScore).toBeNull();
    expect(r.newsSource).toBeNull();
    expect(results.telemetry.newsUnavailable).toBeGreaterThan(0);
    expect(results.telemetry.newsResolved).toBe(0);
  });

  it('runs cleanly with no marketContext at all (newsScore stays null, scan still completes)', async () => {
    const results = await batchScan({
      symbols: ['AAA'],
      timeframe: '5m',
      gateToken: 'test',
      delayMs: 0,
      // no marketContext — newsMap defaults to undefined
    });
    expect(results.length).toBe(1);
    expect(results[0].newsScore).toBeNull();
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

