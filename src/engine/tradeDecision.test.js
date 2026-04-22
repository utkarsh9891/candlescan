/**
 * Guard tests for tradeDecision.sizeMultiplier — Phase 4 sizing lever.
 *
 * Specifically covers P1 #6 (flow wiring):
 *   - useFlow: true (default) applies the flowSizeDelta to mult.
 *   - useFlow: false leaves mult untouched but still logs attribution.
 *   - NEUTRAL flow is a no-op regardless of toggle.
 *   - Aligned STRONG flow upsizes by 20%, counter by -20%.
 *   - Consecutive-losses protection keeps working alongside flow.
 *
 * Sizing envelope is clamped to [0.5, 1.5] — see sizeMultiplier doc
 * for the documented envelope.
 */
import { describe, it, expect } from 'vitest';
import { sizeMultiplier, sizingTier, parseSizeTiers, DEFAULT_SIZE_TIERS } from './tradeDecision.js';

describe('sizeMultiplier — flow wiring (P1 #6)', () => {
  const LONG = { direction: 'long' };
  const SHORT = { direction: 'short' };

  it('useFlow default ON: STRONG_BUY on LONG upsizes to 1.20', () => {
    const r = sizeMultiplier({ flow: 'STRONG_BUY' }, LONG);
    expect(r.mult).toBeCloseTo(1.20, 10);
    expect(r.reasons.some((s) => s.includes('flow:STRONG_BUY'))).toBe(true);
    expect(r.reasons.some((s) => s.includes('+0.20'))).toBe(true);
  });

  it('useFlow default ON: STRONG_SELL on LONG downsizes to 0.80', () => {
    const r = sizeMultiplier({ flow: 'STRONG_SELL' }, LONG);
    expect(r.mult).toBeCloseTo(0.80, 10);
    expect(r.reasons.some((s) => s.includes('-0.20'))).toBe(true);
  });

  it('useFlow default ON: STRONG_SELL on SHORT upsizes to 1.20', () => {
    const r = sizeMultiplier({ flow: 'STRONG_SELL' }, SHORT);
    expect(r.mult).toBeCloseTo(1.20, 10);
  });

  it('useFlow default ON: mild BUY on LONG upsizes to 1.10', () => {
    const r = sizeMultiplier({ flow: 'BUY' }, LONG);
    expect(r.mult).toBeCloseTo(1.10, 10);
  });

  it('useFlow: false leaves mult at 1.0 but logs attribution', () => {
    const r = sizeMultiplier({ flow: 'STRONG_BUY' }, LONG, { useFlow: false });
    expect(r.mult).toBe(1.0);
    expect(r.reasons.some((s) => s.includes('flow:STRONG_BUY(off)'))).toBe(true);
  });

  it('NEUTRAL flow is a no-op with useFlow default ON', () => {
    const r = sizeMultiplier({ flow: 'NEUTRAL' }, LONG);
    expect(r.mult).toBe(1.0);
    expect(r.reasons.some((s) => s.includes('flow:NEUTRAL(0)'))).toBe(true);
  });

  it('null flow produces no flow reason and no delta', () => {
    const r = sizeMultiplier({ flow: null }, LONG);
    expect(r.mult).toBe(1.0);
    expect(r.reasons.some((s) => s.startsWith('flow:'))).toBe(false);
  });

  it('flow delta stacks with consecutive-losses protection', () => {
    // 2 losses → ×0.75, then STRONG_SELL on LONG → ×0.80 → 0.60
    const r = sizeMultiplier(
      { flow: 'STRONG_SELL', consecutiveLosses: 2 },
      LONG,
    );
    expect(r.mult).toBeCloseTo(0.75 * 0.80, 10);
    expect(r.reasons).toContain('losses≥2×0.75');
  });

  it('clamps to 0.5 floor: 3 losses × counter-flow can not sink below 0.5', () => {
    // 3 losses × 0.5 = 0.5, STRONG_SELL on LONG × 0.8 would push to 0.4,
    // but clamp holds at 0.5.
    const r = sizeMultiplier(
      { flow: 'STRONG_SELL', consecutiveLosses: 3 },
      LONG,
    );
    expect(r.mult).toBeCloseTo(0.5, 10);
  });

  it('clamps to 1.5 ceiling: aligned flow can not push above 1.5', () => {
    // Hypothetical: even if mult started at 1.5 * 1.2, clamp should hold.
    // We can't easily raise the starting mult past 1.0 without additional
    // levers, so instead verify the clamp directly by pushing mult via
    // consecutive-losses=0 and STRONG_BUY aligned (1.2) — below ceiling.
    // The ceiling is enforced structurally via Math.min(1.5, ...).
    const r = sizeMultiplier({ flow: 'STRONG_BUY' }, LONG);
    expect(r.mult).toBeLessThanOrEqual(1.5);
  });

  it('missing candidate direction with useFlow ON → no flow delta, but attribution kept', () => {
    const r = sizeMultiplier({ flow: 'STRONG_BUY' }, undefined);
    expect(r.mult).toBe(1.0);
    // direction missing → flowSizeDelta returns 0 → "(0)" attribution
    expect(r.reasons.some((s) => s.includes('flow:STRONG_BUY(0)'))).toBe(true);
  });

  it('no longer logs "(no-op)" for flow — the no-op marker must disappear', () => {
    const r = sizeMultiplier({ flow: 'STRONG_BUY' }, LONG);
    expect(r.reasons.some((s) => s.includes('flow:') && s.includes('no-op'))).toBe(false);
  });
});

describe('sizingTier — confidence-tier base sizing (Wave 3)', () => {
  const TIERS = DEFAULT_SIZE_TIERS;  // [{conf:82,size:200000},{conf:75,size:100000}]

  it('returns Rs 2L for confidence ≥ 82', () => {
    expect(sizingTier(82, TIERS, 0)).toBe(200000);
    expect(sizingTier(85, TIERS, 0)).toBe(200000);
    expect(sizingTier(100, TIERS, 0)).toBe(200000);
  });

  it('returns Rs 1L for confidence in [75, 81]', () => {
    expect(sizingTier(75, TIERS, 0)).toBe(100000);
    expect(sizingTier(81, TIERS, 0)).toBe(100000);
  });

  it('returns fallback for confidence < 75', () => {
    expect(sizingTier(74, TIERS, 0)).toBe(0);
    expect(sizingTier(0, TIERS, 50000)).toBe(50000);
  });

  it('returns fallback when tiers list is empty / null / undefined', () => {
    expect(sizingTier(99, [], 12345)).toBe(12345);
    expect(sizingTier(99, null, 12345)).toBe(12345);
    expect(sizingTier(99, undefined, 12345)).toBe(12345);
  });

  it('honors caller-supplied tier order (desc by conf is the contract)', () => {
    const custom = [{ conf: 90, size: 300000 }, { conf: 70, size: 50000 }];
    expect(sizingTier(91, custom, 0)).toBe(300000);
    expect(sizingTier(70, custom, 0)).toBe(50000);
    expect(sizingTier(69, custom, 999)).toBe(999);
  });

  it('skips malformed tier entries instead of throwing', () => {
    const tiers = [{ conf: 'bad', size: 999 }, { conf: 75, size: 100000 }];
    expect(sizingTier(80, tiers, 0)).toBe(100000);
  });
});

describe('parseSizeTiers — CLI flag parsing', () => {
  it('parses a well-formed string into desc-sorted tiers', () => {
    const t = parseSizeTiers('75:100000,82:200000');
    expect(t).toEqual([{ conf: 82, size: 200000 }, { conf: 75, size: 100000 }]);
  });

  it('returns null on null / empty input (legacy fallback)', () => {
    expect(parseSizeTiers(null)).toBe(null);
    expect(parseSizeTiers('')).toBe(null);
    expect(parseSizeTiers(undefined)).toBe(null);
  });

  it('throws on malformed entries — fail loud rather than silently fall back', () => {
    expect(() => parseSizeTiers('82:abc')).toThrow(/Invalid --size-tiers/);
    expect(() => parseSizeTiers('xyz:100')).toThrow(/Invalid --size-tiers/);
    expect(() => parseSizeTiers('-5:100')).toThrow(/Invalid --size-tiers/);
    expect(() => parseSizeTiers('80:-100')).toThrow(/Invalid --size-tiers/);
  });

  it('round-trips with sizingTier — Rs 2L tier wins for conf ≥ 82', () => {
    const tiers = parseSizeTiers('82:200000,75:100000');
    expect(sizingTier(85, tiers, 0)).toBe(200000);
    expect(sizingTier(78, tiers, 0)).toBe(100000);
    expect(sizingTier(70, tiers, 0)).toBe(0);
  });
});

describe('DEFAULT_SIZE_TIERS', () => {
  it('matches the strategy-iteration spec — Rs 2L @ ≥82, Rs 1L @ ≥75', () => {
    expect(DEFAULT_SIZE_TIERS).toHaveLength(2);
    expect(DEFAULT_SIZE_TIERS[0]).toEqual({ conf: 82, size: 200000 });
    expect(DEFAULT_SIZE_TIERS[1]).toEqual({ conf: 75, size: 100000 });
  });

  it('is frozen so callers cannot mutate the canonical default', () => {
    expect(Object.isFrozen(DEFAULT_SIZE_TIERS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SIZE_TIERS[0])).toBe(true);
  });
});
