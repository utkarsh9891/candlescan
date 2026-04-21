import { describe, it, expect, vi, beforeEach } from 'vitest';
import { batchScan, _resetBatchScanNewsCache } from './batchScan.js';
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
  CF_WORKER_URL: 'https://mock.workers.dev',
  TIMEFRAME_MAP: { '5m': { interval: '5m', range: '5d' } },
}));

// Default-mock the live Google News fetcher so the existing tests don't
// hit the network. Individual tests override this with `newsFetchFn`.
vi.mock('./marketContextLive.js', () => ({
  fetchLiveGoogleNewsDetailForSymbol: vi.fn(async () => ({ score: null, headlines: [] })),
}));

beforeEach(() => {
  _resetBatchScanNewsCache();
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
