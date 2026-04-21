/**
 * Fixture-based test for the `summarize` helper in
 * `scripts/load-test-news.mjs`. The rest of the script (HTTP, CLI, disk
 * I/O) is a smoke tool and deliberately untested — this just pins down
 * the percentile + bucket arithmetic so a refactor doesn't silently
 * flip the pass/fail threshold.
 */

import { describe, it, expect } from 'vitest';
import { summarize } from '../../scripts/load-test-news.mjs';

function mkResult(overrides = {}) {
  return {
    i: 0,
    symbol: 'X',
    startedAt: '2026-04-21T00:00:00Z',
    status: 200,
    ok: true,
    timedOut: false,
    error: null,
    latencyMs: 100,
    bytes: 1000,
    cacheHint: null,
    rateRemaining: null,
    itemCount: 10,
    ...overrides,
  };
}

describe('summarize()', () => {
  it('returns zeroed summary for an empty results array', () => {
    const s = summarize([]);
    expect(s.total).toBe(0);
    expect(s.success).toBe(0);
    expect(s.successRate).toBe(0);
    expect(s.latency).toEqual({ p50: 0, p95: 0, p99: 0, max: 0, mean: 0 });
    expect(s.cacheHitRate).toBe(null);
    expect(s.minRateRemaining).toBe(null);
    // Empty set vacuously satisfies both thresholds (successRate 0 fails 95% floor)
    expect(s.pass).toBe(false);
  });

  it('counts 4xx, 5xx, timeouts, and network errors separately', () => {
    const results = [
      mkResult({ status: 200, ok: true }),
      mkResult({ status: 200, ok: true }),
      mkResult({ status: 404, ok: false }),
      mkResult({ status: 500, ok: false }),
      mkResult({ status: 502, ok: false }),
      mkResult({ status: 0, ok: false, timedOut: true, error: 'timeout' }),
      mkResult({ status: 0, ok: false, error: 'ECONNRESET' }),
    ];
    const s = summarize(results);
    expect(s.total).toBe(7);
    expect(s.success).toBe(2);
    expect(s.status4xx).toBe(1);
    expect(s.status5xx).toBe(2);
    expect(s.timeouts).toBe(1);
    expect(s.networkErrors).toBe(1);
    expect(s.fail).toBe(5);
  });

  it('computes p50 / p95 / p99 / max / mean latency', () => {
    // 100 samples: 1..100ms. p50 ≈ 50, p95 ≈ 95, p99 ≈ 99, max = 100.
    const results = Array.from({ length: 100 }, (_, i) =>
      mkResult({ i, latencyMs: i + 1 }));
    const s = summarize(results);
    expect(s.latency.max).toBe(100);
    expect(s.latency.p50).toBeGreaterThanOrEqual(50);
    expect(s.latency.p50).toBeLessThanOrEqual(51);
    expect(s.latency.p95).toBeGreaterThanOrEqual(95);
    expect(s.latency.p95).toBeLessThanOrEqual(96);
    expect(s.latency.p99).toBeGreaterThanOrEqual(99);
    expect(s.latency.p99).toBeLessThanOrEqual(100);
    expect(s.latency.mean).toBeGreaterThan(45);
    expect(s.latency.mean).toBeLessThan(55);
  });

  it('computes cache-hit rate only over requests that emitted a cache header', () => {
    const results = [
      mkResult({ cacheHint: 'HIT' }),
      mkResult({ cacheHint: 'MISS' }),
      mkResult({ cacheHint: 'hit' }),   // case-insensitive
      mkResult({ cacheHint: null }),    // excluded from denominator
      mkResult({ cacheHint: null }),
    ];
    const s = summarize(results);
    expect(s.cacheSamples).toBe(3);
    expect(s.cacheHits).toBe(2);
    expect(s.cacheHitRate).toBeCloseTo(2 / 3, 5);
  });

  it('tracks minimum x-ratelimit-remaining across requests', () => {
    const results = [
      mkResult({ rateRemaining: 100 }),
      mkResult({ rateRemaining: 42 }),
      mkResult({ rateRemaining: 80 }),
      mkResult({ rateRemaining: null }),
    ];
    const s = summarize(results);
    expect(s.minRateRemaining).toBe(42);
  });

  it('pass=true only when successRate >= 0.95 AND p95 <= 3000ms', () => {
    // 20 requests, 1 failure = 95% exactly. All fast.
    const passing = [
      ...Array.from({ length: 19 }, () => mkResult({ latencyMs: 500 })),
      mkResult({ ok: false, status: 500, latencyMs: 1000 }),
    ];
    expect(summarize(passing).pass).toBe(true);

    // 10% failure — below threshold.
    const failRate = [
      ...Array.from({ length: 18 }, () => mkResult({ latencyMs: 500 })),
      mkResult({ ok: false, status: 500 }),
      mkResult({ ok: false, status: 500 }),
    ];
    expect(summarize(failRate).pass).toBe(false);

    // 100% success but p95 too high.
    const failLatency = Array.from({ length: 20 }, (_, i) =>
      mkResult({ latencyMs: i >= 18 ? 5000 : 500 }));
    const s = summarize(failLatency);
    expect(s.success).toBe(20);
    expect(s.latency.p95).toBeGreaterThan(3000);
    expect(s.pass).toBe(false);
  });

  it('aggregates total bytes across all results', () => {
    const results = [
      mkResult({ bytes: 1000 }),
      mkResult({ bytes: 2500 }),
      mkResult({ bytes: 0 }),
    ];
    expect(summarize(results).totalBytes).toBe(3500);
  });
});
