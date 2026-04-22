/**
 * Guard tests for the Intraday Momentum Runner pattern in patterns-v2.js.
 *
 * Pattern fires when:
 *   - barIndex in [3, 50]
 *   - stockIntraPct ≥ 3% (long) / ≤ -3% (short) from session open
 *   - volFactor ≥ 2.0 (cur.v / 10-bar trailing avg)
 *   - cur.c > vwap (long) / cur.c < vwap (short)
 *   - cur is bullish (long) / bearish (short)
 *   - if indexDirection.intradayPct provided: stock_pct - index_pct ≥ 2%
 *   - no failed breakout in last 6 bars
 */
import { describe, it, expect } from 'vitest';
import { detectPatterns } from './patterns-v2.js';

/** Build a candle. */
function bar(o, h, l, c, v, t = 0) { return { o, h, l, c, v, t }; }

/**
 * Build a synthetic intraday session that ramps from `open` to `endClose`
 * over `nBars` candles, with `volMult` × baseVolume on the latest bar.
 * Each prior bar uses baseVolume.
 */
function rampingSession({ open, endClose, nBars, baseVol = 1000, surgeVol = 4000 }) {
  const candles = [];
  for (let i = 0; i < nBars; i++) {
    const frac = i / (nBars - 1 || 1);
    const c = open + (endClose - open) * frac;
    const o = i === 0 ? open : candles[i - 1].c;
    const h = Math.max(o, c) * 1.001;
    const l = Math.min(o, c) * 0.999;
    const v = i === nBars - 1 ? surgeVol : baseVol;
    candles.push(bar(o, h, l, c, v, i * 300));
  }
  return candles;
}

describe('Intraday Momentum Runner — long', () => {
  it('fires on a clean +5% session with 4x volume surge', () => {
    const candles = rampingSession({ open: 100, endClose: 105.5, nBars: 15 });
    const patterns = detectPatterns(candles, { barIndex: 14, stockDayOpen: 100 });
    const runner = patterns.find(p => p.name === 'Intraday Momentum Runner');
    expect(runner).toBeDefined();
    expect(runner.direction).toBe('bullish');
    expect(runner.strength).toBeGreaterThanOrEqual(0.88);
    expect(runner.strength).toBeLessThanOrEqual(0.95);
  });

  it('does NOT fire when intra-pct < 3% (1.5% move)', () => {
    const candles = rampingSession({ open: 100, endClose: 101.5, nBars: 15 });
    const patterns = detectPatterns(candles, { barIndex: 14, stockDayOpen: 100 });
    expect(patterns.find(p => p.name === 'Intraday Momentum Runner')).toBeUndefined();
  });

  it('does NOT fire in the first 3 bars of session', () => {
    const candles = rampingSession({ open: 100, endClose: 110, nBars: 4 });
    const patterns = detectPatterns(candles, { barIndex: 2, stockDayOpen: 100 });
    expect(patterns.find(p => p.name === 'Intraday Momentum Runner')).toBeUndefined();
  });

  it('does NOT fire after bar 50 (cap)', () => {
    const candles = rampingSession({ open: 100, endClose: 110, nBars: 60 });
    const patterns = detectPatterns(candles, { barIndex: 51, stockDayOpen: 100 });
    expect(patterns.find(p => p.name === 'Intraday Momentum Runner')).toBeUndefined();
  });

  it('does NOT fire without volume surge (volFactor < 2)', () => {
    const candles = rampingSession({ open: 100, endClose: 105, nBars: 15, baseVol: 1000, surgeVol: 1500 });
    const patterns = detectPatterns(candles, { barIndex: 14, stockDayOpen: 100 });
    expect(patterns.find(p => p.name === 'Intraday Momentum Runner')).toBeUndefined();
  });

  it('does NOT fire when current bar is bearish (close < open)', () => {
    const candles = rampingSession({ open: 100, endClose: 105, nBars: 15 });
    // Flip the last bar bearish while keeping it >3% above open
    const last = candles[candles.length - 1];
    candles[candles.length - 1] = bar(last.c + 0.5, last.c + 0.6, last.c - 0.2, last.c, last.v, last.t);
    const patterns = detectPatterns(candles, { barIndex: 14, stockDayOpen: 100 });
    expect(patterns.find(p => p.name === 'Intraday Momentum Runner')).toBeUndefined();
  });

  it('falls back to candles[0].o when stockDayOpen is not provided', () => {
    const candles = rampingSession({ open: 100, endClose: 106, nBars: 15 });
    const patterns = detectPatterns(candles, { barIndex: 14 });
    expect(patterns.find(p => p.name === 'Intraday Momentum Runner')).toBeDefined();
  });

  it('respects RS gate when index direction is provided (rejects when stock-index < 2%)', () => {
    const candles = rampingSession({ open: 100, endClose: 103.5, nBars: 15 });  // +3.5%
    // Index also up 2% => stock RS = 1.5% (below 2% gate)
    const patterns = detectPatterns(candles, {
      barIndex: 14, stockDayOpen: 100,
      indexDirection: { intradayPct: 0.02 },
    });
    expect(patterns.find(p => p.name === 'Intraday Momentum Runner')).toBeUndefined();
  });

  it('passes RS gate when stock outperforms index by ≥ 2%', () => {
    const candles = rampingSession({ open: 100, endClose: 105, nBars: 15 });  // +5%
    const patterns = detectPatterns(candles, {
      barIndex: 14, stockDayOpen: 100,
      indexDirection: { intradayPct: 0.02 },  // index +2%, stock RS = 3%
    });
    expect(patterns.find(p => p.name === 'Intraday Momentum Runner')).toBeDefined();
  });
});

describe('Intraday Momentum Runner — short (mirror)', () => {
  it('fires on a clean -5% session with 4x volume surge', () => {
    const candles = rampingSession({ open: 100, endClose: 94.5, nBars: 15 });
    const patterns = detectPatterns(candles, { barIndex: 14, stockDayOpen: 100 });
    const runner = patterns.find(p => p.name === 'Intraday Momentum Runner');
    expect(runner).toBeDefined();
    expect(runner.direction).toBe('bearish');
    expect(runner.strength).toBeGreaterThanOrEqual(0.88);
  });

  it('does NOT fire when intra-pct > -3% (only -1% drop)', () => {
    const candles = rampingSession({ open: 100, endClose: 99, nBars: 15 });
    const patterns = detectPatterns(candles, { barIndex: 14, stockDayOpen: 100 });
    expect(patterns.find(p => p.name === 'Intraday Momentum Runner')).toBeUndefined();
  });
});

describe('Intraday Momentum Runner — sorting & strength', () => {
  it('sorts above the existing reversal patterns (max strength ~0.85)', () => {
    const candles = rampingSession({ open: 100, endClose: 106, nBars: 15 });
    const patterns = detectPatterns(candles, { barIndex: 14, stockDayOpen: 100 });
    expect(patterns.length).toBeGreaterThan(0);
    // The top pattern (after the internal sort) should be the runner.
    expect(patterns[0].name).toBe('Intraday Momentum Runner');
  });

  it('has reliability 0.72 (peer-validated; higher than first-pullback 0.55)', () => {
    const candles = rampingSession({ open: 100, endClose: 106, nBars: 15 });
    const patterns = detectPatterns(candles, { barIndex: 14, stockDayOpen: 100 });
    const runner = patterns.find(p => p.name === 'Intraday Momentum Runner');
    expect(runner.reliability).toBe(0.72);
  });
});
