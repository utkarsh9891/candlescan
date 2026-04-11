/**
 * Proximity detector tests.
 *
 * Verifies the "forming up" scorer used by Novice Mode's watch list.
 * These tests focus on the contract, not the exact numerics — the
 * score is a soft signal for UI display, not a trading decision.
 */
import { describe, it, expect } from 'vitest';
import { detectProximity, classifyForNovice, PROXIMITY_TIERS } from './proximity-scalp.js';

/**
 * Build a synthetic intraday candle series.
 *
 * @param {Object} cfg
 * @param {number} cfg.bars — number of 1-minute bars to produce
 * @param {number} cfg.dayOpen — price at bar 0
 * @param {number} cfg.dayMovePct — total move (0.012 = +1.2%) from open → last close
 * @param {number} [cfg.vol=1000] — reference volume for most bars
 * @param {number} [cfg.lastVolMult=1] — final bar volume multiplier (for vol spike)
 * @param {'up'|'down'|'flat'} [cfg.lastBarDirection='up']
 * @param {number} [cfg.pullbackPct=0] — final bar distance from VWAP as fraction of price
 */
function buildSeries({
  bars = 30,
  dayOpen = 100,
  dayMovePct = 0.012,
  vol = 1000,
  lastVolMult = 1,
  lastBarDirection = 'up',
  // pullbackPct influences the shape: price swings above/below VWAP
  pullbackPct = 0.001,
}) {
  const candles = [];
  const finalPrice = dayOpen * (1 + dayMovePct);
  // Straight-line interpolation for simplicity. VWAP ~ halfway.
  for (let i = 0; i < bars - 1; i++) {
    const t = i / (bars - 1);
    const base = dayOpen + (finalPrice - dayOpen) * t;
    // Small intra-bar variation so h/l/o/c differ
    const o = base - 0.01;
    const c = base + 0.01;
    const h = base + 0.05;
    const l = base - 0.05;
    candles.push({ t: i * 60, o, h, l, c, v: vol });
  }
  // Final bar — controllable shape
  const prevC = candles[candles.length - 1].c;
  const targetC = finalPrice * (1 + (lastBarDirection === 'up' ? pullbackPct : -pullbackPct));
  const o = lastBarDirection === 'down' ? targetC + 0.1 : targetC - 0.1;
  const c = targetC;
  const h = Math.max(o, c) + 0.03;
  const l = Math.min(o, c) - 0.03;
  candles.push({ t: (bars - 1) * 60, o, h, l, c, v: vol * lastVolMult });
  return candles;
}

const BULLISH_IDX = { direction: 'bullish', strength: 0.5, intradayPct: 0.003, preWindowMove: 0.003 };
const BEARISH_IDX = { direction: 'bearish', strength: 0.5, intradayPct: -0.003, preWindowMove: -0.003 };
const NEUTRAL_IDX = { direction: 'neutral', strength: 0, intradayPct: 0, preWindowMove: null };

describe('detectProximity — hard constraints', () => {
  it('returns null when candles array is too short', () => {
    const r = detectProximity([], { barIndex: 0, indexDirection: BULLISH_IDX });
    expect(r).toBeNull();
  });

  it('returns null without indexDirection', () => {
    const candles = buildSeries({ bars: 30, dayMovePct: 0.012 });
    const r = detectProximity(candles, { barIndex: 30 });
    expect(r).toBeNull();
  });

  it('returns null when index preWindowMove is missing (chop day)', () => {
    const candles = buildSeries({ bars: 30, dayMovePct: 0.012 });
    const r = detectProximity(candles, { barIndex: 30, indexDirection: NEUTRAL_IDX });
    expect(r).toBeNull();
  });

  it('returns null past the extended trading window (barIndex > 60)', () => {
    const candles = buildSeries({ bars: 80, dayMovePct: 0.012 });
    const r = detectProximity(candles, { barIndex: 61, indexDirection: BULLISH_IDX });
    expect(r).toBeNull();
  });

  it('returns null for a flat stock (no move in either direction)', () => {
    const candles = buildSeries({ bars: 30, dayMovePct: 0.0005 });
    const r = detectProximity(candles, { barIndex: 30, indexDirection: BULLISH_IDX });
    // No meaningful move — not a watchlist candidate.
    expect(r).toBeNull();
  });
});

describe('detectProximity — long setup', () => {
  it('a strong-but-not-quite-there long stock scores high proximity', () => {
    // +1.2% day move, bullish market, volume spike, tight pullback
    const candles = buildSeries({
      bars: 30,
      dayMovePct: 0.012,
      lastVolMult: 1.4,
      lastBarDirection: 'up',
      pullbackPct: 0.001,
    });
    const r = detectProximity(candles, { barIndex: 30, indexDirection: BULLISH_IDX });
    expect(r).not.toBeNull();
    expect(r.direction).toBe('long');
    expect(r.proximity).toBeGreaterThan(0.5);
  });

  it('a weak long stock scores lower proximity', () => {
    // Only +0.6% day move, normal volume — still in the right direction
    // but clearly early
    const candles = buildSeries({
      bars: 30,
      dayMovePct: 0.006,
      lastVolMult: 1.0,
      lastBarDirection: 'up',
      pullbackPct: 0.001,
    });
    const r = detectProximity(candles, { barIndex: 30, indexDirection: BULLISH_IDX });
    expect(r).not.toBeNull();
    expect(r.direction).toBe('long');
    expect(r.proximity).toBeLessThan(0.7);
  });

  it('missing list contains plain-english hints', () => {
    const candles = buildSeries({ bars: 30, dayMovePct: 0.006, lastVolMult: 1.0 });
    const r = detectProximity(candles, { barIndex: 30, indexDirection: BULLISH_IDX });
    expect(r).not.toBeNull();
    // At least one item in either missing or present
    expect((r.missing?.length || 0) + (r.present?.length || 0)).toBeGreaterThan(0);
    // No jargon
    r.missing.forEach((m) => {
      expect(m).not.toMatch(/VWAP|EMA|ATR|confidence|r:r/i);
    });
  });

  it('hint is one line of plain English', () => {
    const candles = buildSeries({ bars: 30, dayMovePct: 0.012, lastVolMult: 1.4 });
    const r = detectProximity(candles, { barIndex: 30, indexDirection: BULLISH_IDX });
    expect(r).not.toBeNull();
    expect(typeof r.hint).toBe('string');
    expect(r.hint.length).toBeGreaterThan(0);
    expect(r.hint).not.toMatch(/\n/);
  });
});

describe('detectProximity — short setup', () => {
  it('a strong-but-not-quite-there short stock scores high proximity on a bearish day', () => {
    const candles = buildSeries({
      bars: 30,
      dayMovePct: -0.012,
      lastVolMult: 1.4,
      lastBarDirection: 'down',
      pullbackPct: 0.001,
    });
    const r = detectProximity(candles, { barIndex: 30, indexDirection: BEARISH_IDX });
    expect(r).not.toBeNull();
    expect(r.direction).toBe('short');
    expect(r.proximity).toBeGreaterThan(0.5);
  });

  it('wrong-direction stock returns null (up on bearish day)', () => {
    const candles = buildSeries({ bars: 30, dayMovePct: 0.012 });
    const r = detectProximity(candles, { barIndex: 30, indexDirection: BEARISH_IDX });
    expect(r).toBeNull();
  });
});

describe('detectProximity — return shape', () => {
  it('returned object carries all documented fields', () => {
    const candles = buildSeries({ bars: 30, dayMovePct: 0.012, lastVolMult: 1.4 });
    const r = detectProximity(candles, { barIndex: 30, indexDirection: BULLISH_IDX });
    expect(r).not.toBeNull();
    expect(r).toHaveProperty('direction');
    expect(r).toHaveProperty('proximity');
    expect(r).toHaveProperty('stockIntraPct');
    expect(r).toHaveProperty('rs');
    expect(r).toHaveProperty('pullbackPct');
    expect(r).toHaveProperty('volFactor');
    expect(r).toHaveProperty('missing');
    expect(r).toHaveProperty('present');
    expect(r).toHaveProperty('hint');
    expect(r).toHaveProperty('tags');
    expect(Array.isArray(r.tags)).toBe(true);
  });

  it('proximity is clamped to [0, 1]', () => {
    // Very strong setup
    const strong = buildSeries({
      bars: 30, dayMovePct: 0.025, lastVolMult: 3, pullbackPct: 0.0005,
    });
    const r1 = detectProximity(strong, { barIndex: 30, indexDirection: BULLISH_IDX });
    if (r1) {
      expect(r1.proximity).toBeGreaterThanOrEqual(0);
      expect(r1.proximity).toBeLessThanOrEqual(1);
    }
    // Very weak setup
    const weak = buildSeries({ bars: 30, dayMovePct: 0.006, lastVolMult: 0.8 });
    const r2 = detectProximity(weak, { barIndex: 30, indexDirection: BULLISH_IDX });
    if (r2) {
      expect(r2.proximity).toBeGreaterThanOrEqual(0);
      expect(r2.proximity).toBeLessThanOrEqual(1);
    }
  });
});

describe('classifyForNovice', () => {
  it('maps BUY / STRONG BUY to trade-now', () => {
    expect(classifyForNovice({ action: 'BUY', confidence: 78 }, null)).toBe('trade-now');
    expect(classifyForNovice({ action: 'STRONG BUY', confidence: 88 }, null)).toBe('trade-now');
    expect(classifyForNovice({ action: 'SHORT', confidence: 78 }, null)).toBe('trade-now');
    expect(classifyForNovice({ action: 'STRONG SHORT', confidence: 88 }, null)).toBe('trade-now');
  });

  it('does NOT map gated results to trade-now', () => {
    const gated = { action: 'BUY', confidence: 78, gatedReason: 'counter-news' };
    expect(classifyForNovice(gated, null)).not.toBe('trade-now');
  });

  it('WAIT with confidence >= 60 becomes imminent', () => {
    expect(classifyForNovice({ action: 'WAIT', confidence: 65 }, null)).toBe('imminent');
  });

  it('proximity >= 0.85 becomes imminent even if confidence is lower', () => {
    expect(classifyForNovice(
      { action: 'NO TRADE', confidence: 40 },
      { proximity: 0.9 }
    )).toBe('imminent');
  });

  it('proximity 0.6..0.85 becomes building', () => {
    expect(classifyForNovice(
      { action: 'NO TRADE', confidence: 40 },
      { proximity: 0.7 }
    )).toBe('building');
  });

  it('proximity 0.4..0.6 becomes early', () => {
    expect(classifyForNovice(
      { action: 'NO TRADE', confidence: 40 },
      { proximity: 0.5 }
    )).toBe('early');
  });

  it('proximity < 0.4 becomes ignore', () => {
    expect(classifyForNovice(
      { action: 'NO TRADE', confidence: 40 },
      { proximity: 0.2 }
    )).toBe('ignore');
  });

  it('null result returns ignore', () => {
    expect(classifyForNovice(null, null)).toBe('ignore');
  });

  it('tier constants are exported and ordered', () => {
    expect(PROXIMITY_TIERS.IMMINENT).toBeGreaterThan(PROXIMITY_TIERS.BUILDING);
    expect(PROXIMITY_TIERS.BUILDING).toBeGreaterThan(PROXIMITY_TIERS.EARLY);
  });
});
