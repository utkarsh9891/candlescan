/**
 * Browser / CLI simulation parity — P0 #5.
 *
 * Pins two invariants about the browser sim's output:
 *   1. Every emitted trade carries a `features` object (or null when the
 *      signal came from the noTrade path) — gate-level attribution
 *      payload threaded from computeRiskScore() through the position
 *      into the trade record.
 *   2. Every emitted trade carries a `contextSnapshot` object (never
 *      undefined) — day-level market context captured at entry. With
 *      UNKNOWN sentinels the snapshot values can be null, but the
 *      container must be an object so downstream joins never crash.
 *
 * We mock network fetchers + the engine so trades fire deterministically.
 * The test is about threading, not about the scalp pattern firing.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock network dependencies BEFORE importing the module under test.
vi.mock('./nseIndexFetch.js', () => ({
  fetchNseIndexSymbolList: vi.fn(async () => ['STUBA', 'STUBB']),
}));

// Build a tidy day of 1m candles spanning 09:15-10:30 IST on 2026-04-10.
// The simulator's istDate(t) = new Date((t + 19800)*1000).toISOString(),
// so we subtract the IST offset from the UTC epoch at 09:15 IST to land
// on the right civil date regardless of local timezone.
const IST_OFFSET = 19800; // +5:30 in seconds
const DAY_START_TS = Math.floor(new Date('2026-04-10T09:15:00.000Z').getTime() / 1000) - IST_OFFSET;
function buildDayCandles() {
  const out = [];
  // 76 bars covers 09:15 → 10:30 inclusive
  for (let i = 0; i < 76; i++) {
    const base = 100 + i * 0.02;
    out.push({
      t: DAY_START_TS + i * 60,
      o: base,
      h: base + 0.1,
      l: base - 0.1,
      c: base + 0.05,
      v: 10_000 + i,
    });
  }
  return out;
}

vi.mock('./fetcher.js', () => ({
  fetchOHLCV: vi.fn(async (sym) => ({
    candles: buildDayCandles(),
    live: true,
    simulated: false,
    yahooSymbol: `${sym}.NS`,
    displaySymbol: sym,
    companyName: `${sym} Ltd`,
  })),
}));

// Import AFTER mocks are set up so the module picks up the stubs.
const { runSimulation } = await import('./simulateDay.js');

// Engine stub that always returns an actionable BUY with a canned
// features payload. Pattern/box detectors return benign non-empty data.
const stubEngine = {
  detectPatterns: () => ([{ name: 'StubPattern', direction: 'bullish', strength: 0.9 }]),
  detectLiquidityBox: () => null,
  computeRiskScore: ({ candles }) => {
    const cur = candles[candles.length - 1];
    return {
      total: 90,
      confidence: 90,
      breakdown: { signalClarity: 27, relativeStrength: 20, volume: 15, riskReward: 20, regime: 10 },
      level: 'high',
      action: 'STRONG BUY',
      entry: cur.c,
      sl: cur.c * 0.995,
      target: cur.c * 1.01,
      rr: 2.0,
      direction: 'long',
      context: 'mid_range',
      maxHoldBars: 15,
      signalBarTs: cur.t,
      validTillTs: cur.t + 180,
      features: {
        intraPct: 0.004,
        rs: 0.002,
        vwapDist: null,
        volFactor: 1.5,
        pullbackPct: null,
        emaDiff: null,
        preWindowMove: 0.001,
        patternStrength: 0.9,
        idxIntraPct: 0.002,
      },
    };
  },
};

describe('simulateDay — browser/CLI parity', () => {
  it('every trade carries features + contextSnapshot objects', async () => {
    const res = await runSimulation({
      indexName: 'NIFTY 50',
      timeframe: '1m',
      date: '2026-04-10',
      startTime: '09:15',
      endTime: '10:30',
      engineFns: stubEngine,
      capital: 300000,
      positionSize: 300000,
      maxConcurrent: 1,
      maxTotalTrades: 5,
      minConfidence: 75,
      skipFirstBars: 0,
      minAvgVolume: 0,
    });

    expect(res.trades.length).toBeGreaterThan(0);

    const t = res.trades[0];
    // contextSnapshot must be an object (values may be null sentinels).
    expect(t.contextSnapshot).toBeTypeOf('object');
    expect(t.contextSnapshot).not.toBeNull();
    expect(t.contextSnapshot).toHaveProperty('vixRegime');
    expect(t.contextSnapshot).toHaveProperty('liquidity');
    expect(t.contextSnapshot).toHaveProperty('sentiment');
    expect(t.contextSnapshot).toHaveProperty('sizeMult');
    expect(t.contextSnapshot).toHaveProperty('consecutiveLosses');

    // features object forwarded from the risk scorer.
    expect(t.features).toBeTypeOf('object');
    expect(t.features).not.toBeNull();
    expect(t.features).toHaveProperty('volFactor');
    expect(t.features).toHaveProperty('patternStrength');
  });

  it('marketCtx in the simulator is never the literal null constant', async () => {
    // Guard: the "const marketCtx = null" escape-hatch must stay gone.
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(new URL('./simulateDay.js', import.meta.url), 'utf8');
    expect(src.includes('marketCtx = null')).toBe(false);
  });
});
