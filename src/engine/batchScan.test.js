import { describe, it, expect, vi } from 'vitest';
import { batchScan } from './batchScan.js';
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
});
