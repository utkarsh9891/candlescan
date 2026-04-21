/**
 * Guard tests for marketContext — the multi-factor composer.
 *
 * Pins the behaviors CLAUDE.md rule #4 cares about:
 *   - Layers can VETO a trade.
 *   - News sentiment (the strongest-predictive layer) can give +2 / +5
 *     confidence bonuses when aligned with the trade direction.
 *   - Other layers (gap, liquidity, flow) contribute NO positive delta —
 *     they're either informational or veto-only in the composer.
 *
 * KNOWN DISCREPANCY: vixConfidenceDelta('LOW') returns +2 (marketContext.js:69),
 * and the composer applies it. CLAUDE.md rule #4 says "positive confidence
 * bonuses from VIX/gap/liquidity/flow are kept at 0 by design". The VIX LOW
 * case therefore violates the documented rule. These tests pin the CURRENT
 * behavior so it can't drift further; tightening VIX LOW to 0 is a strategy
 * change that requires a 17-day sweep before shipping.
 */
import { describe, it, expect } from 'vitest';
import {
  vixRegime,
  vixAllowsTrading,
  vixConfidenceDelta,
  classifyGap,
  gapAlignment,
  liquidityTier,
  liquidityAllowsTrading,
  classifyInstitutionalFlow,
  flowAlignment,
  flowSizeDelta,
  classifyNewsSentiment,
  newsAlignment,
  composeContextScore,
} from './marketContext.js';

describe('marketContext — classifiers', () => {
  it('vixRegime partitions the VIX range correctly', () => {
    expect(vixRegime(null)).toBeNull();
    expect(vixRegime(NaN)).toBeNull();
    expect(vixRegime(12)).toBe('LOW');
    expect(vixRegime(18)).toBe('NORMAL');
    expect(vixRegime(25)).toBe('HIGH');
    expect(vixRegime(30)).toBe('PANIC');
  });

  it('vixAllowsTrading blocks PANIC only', () => {
    expect(vixAllowsTrading('LOW')).toBe(true);
    expect(vixAllowsTrading('NORMAL')).toBe(true);
    expect(vixAllowsTrading('HIGH')).toBe(true);
    expect(vixAllowsTrading('PANIC')).toBe(false);
  });

  it('classifyGap respects 0.3% / 1% thresholds', () => {
    expect(classifyGap(100, 102)).toBe('GAP_UP_STRONG');
    expect(classifyGap(100, 100.5)).toBe('GAP_UP');
    expect(classifyGap(100, 100.1)).toBe('FLAT');
    expect(classifyGap(100, 99.5)).toBe('GAP_DOWN');
    expect(classifyGap(100, 98)).toBe('GAP_DOWN_STRONG');
    expect(classifyGap(0, 100)).toBeNull();
  });

  it('liquidityTier partitions by per-bar average volume', () => {
    expect(liquidityTier(null)).toBeNull();
    expect(liquidityTier(0)).toBeNull();
    expect(liquidityTier(10_000)).toBe('TIER_A');
    expect(liquidityTier(3_000)).toBe('TIER_B');
    expect(liquidityTier(800)).toBe('TIER_C');
    expect(liquidityTier(200)).toBe('TIER_D');
  });

  it('liquidityAllowsTrading blocks TIER_D only', () => {
    expect(liquidityAllowsTrading('TIER_A')).toBe(true);
    expect(liquidityAllowsTrading('TIER_D')).toBe(false);
  });

  it('classifyInstitutionalFlow classifies by sign + 500cr threshold', () => {
    expect(classifyInstitutionalFlow(400, 300)).toBe('STRONG_BUY');   // both pos, combined > 500
    expect(classifyInstitutionalFlow(100, 50)).toBe('BUY');           // combined > 0
    expect(classifyInstitutionalFlow(-100, -50)).toBe('SELL');        // combined < 0, not both strong
    expect(classifyInstitutionalFlow(-400, -300)).toBe('STRONG_SELL');// both neg, combined < -500
    expect(classifyInstitutionalFlow(0, 0)).toBe('NEUTRAL');          // combined === 0
    expect(classifyInstitutionalFlow(null, 100)).toBeNull();
  });

  it('classifyNewsSentiment respects symmetric thresholds', () => {
    expect(classifyNewsSentiment(0.7)).toBe('BULLISH_STRONG');
    expect(classifyNewsSentiment(0.3)).toBe('BULLISH');
    expect(classifyNewsSentiment(0)).toBe('NEUTRAL');
    expect(classifyNewsSentiment(-0.3)).toBe('BEARISH');
    expect(classifyNewsSentiment(-0.7)).toBe('BEARISH_STRONG');
    expect(classifyNewsSentiment(null)).toBeNull();
  });
});

describe('marketContext — alignment', () => {
  it('gapAlignment: aligned +1, counter -1, flat 0', () => {
    expect(gapAlignment('GAP_UP_STRONG', 'long')).toBe(1);
    expect(gapAlignment('GAP_UP', 'short')).toBe(-1);
    expect(gapAlignment('FLAT', 'long')).toBe(0);
    expect(gapAlignment(null, 'long')).toBe(0);
  });

  it('flowAlignment: aligned +1, counter -1, neutral 0', () => {
    expect(flowAlignment('STRONG_BUY', 'long')).toBe(1);
    expect(flowAlignment('SELL', 'long')).toBe(-1);
    expect(flowAlignment('NEUTRAL', 'long')).toBe(0);
  });

  it('newsAlignment: STRONG-counter is a hard VETO', () => {
    expect(newsAlignment('BEARISH_STRONG', 'long')).toBe('VETO');
    expect(newsAlignment('BULLISH_STRONG', 'short')).toBe('VETO');
    expect(newsAlignment('BEARISH', 'long')).toBe(-1);
    expect(newsAlignment('BULLISH_STRONG', 'long')).toBe(1);
  });
});

describe('flowSizeDelta — FII/DII alignment sizing (P1 #6)', () => {
  // Strong flow × aligned direction → +0.20 (upsize to 120%)
  it('STRONG_BUY on LONG  → +0.20', () => {
    expect(flowSizeDelta('STRONG_BUY', 'long')).toBeCloseTo(+0.20, 10);
  });
  it('STRONG_SELL on SHORT → +0.20', () => {
    expect(flowSizeDelta('STRONG_SELL', 'short')).toBeCloseTo(+0.20, 10);
  });

  // Strong flow × opposing direction → -0.20 (downsize to 80%)
  it('STRONG_BUY on SHORT → -0.20', () => {
    expect(flowSizeDelta('STRONG_BUY', 'short')).toBeCloseTo(-0.20, 10);
  });
  it('STRONG_SELL on LONG → -0.20', () => {
    expect(flowSizeDelta('STRONG_SELL', 'long')).toBeCloseTo(-0.20, 10);
  });

  // Mild flow → half the magnitude
  it('BUY on LONG  → +0.10', () => {
    expect(flowSizeDelta('BUY', 'long')).toBeCloseTo(+0.10, 10);
  });
  it('SELL on SHORT → +0.10', () => {
    expect(flowSizeDelta('SELL', 'short')).toBeCloseTo(+0.10, 10);
  });
  it('BUY on SHORT → -0.10', () => {
    expect(flowSizeDelta('BUY', 'short')).toBeCloseTo(-0.10, 10);
  });
  it('SELL on LONG → -0.10', () => {
    expect(flowSizeDelta('SELL', 'long')).toBeCloseTo(-0.10, 10);
  });

  // Neutral / missing → 0
  it('NEUTRAL flow → 0', () => {
    expect(flowSizeDelta('NEUTRAL', 'long')).toBe(0);
    expect(flowSizeDelta('NEUTRAL', 'short')).toBe(0);
  });
  it('null flow → 0', () => {
    expect(flowSizeDelta(null, 'long')).toBe(0);
  });
  it('undefined flow → 0', () => {
    expect(flowSizeDelta(undefined, 'long')).toBe(0);
  });
  it('missing direction → 0', () => {
    expect(flowSizeDelta('STRONG_BUY', null)).toBe(0);
    expect(flowSizeDelta('STRONG_BUY', undefined)).toBe(0);
    expect(flowSizeDelta('STRONG_BUY', 'sideways')).toBe(0);
  });

  // Delta always caps at ±0.20
  it('magnitude never exceeds 0.20', () => {
    for (const flow of ['STRONG_BUY', 'BUY', 'NEUTRAL', 'SELL', 'STRONG_SELL', null]) {
      for (const dir of ['long', 'short']) {
        const d = flowSizeDelta(flow, dir);
        expect(Math.abs(d), `flow=${flow} dir=${dir}`).toBeLessThanOrEqual(0.20 + 1e-9);
      }
    }
  });
});

describe('composeContextScore — the layer composition', () => {
  const emptyCtx = {
    vixRegime: null, gap: null, liquidity: null, flow: null, sentiment: null,
  };

  it('all-null context → delta 0, no veto', () => {
    const r = composeContextScore(emptyCtx, 'long');
    expect(r.delta).toBe(0);
    expect(r.veto).toBe(false);
  });

  it('VIX PANIC is a hard veto', () => {
    const r = composeContextScore({ ...emptyCtx, vixRegime: 'PANIC' }, 'long');
    expect(r.veto).toBe(true);
  });

  it('liquidity TIER_D is a hard veto', () => {
    const r = composeContextScore({ ...emptyCtx, liquidity: 'TIER_D' }, 'long');
    expect(r.veto).toBe(true);
  });

  it('BEARISH_STRONG news + long direction → veto', () => {
    const r = composeContextScore({ ...emptyCtx, sentiment: 'BEARISH_STRONG' }, 'long');
    expect(r.veto).toBe(true);
  });

  it('BULLISH_STRONG news + long direction → +5 bonus', () => {
    const r = composeContextScore({ ...emptyCtx, sentiment: 'BULLISH_STRONG' }, 'long');
    expect(r.delta).toBe(5);
    expect(r.veto).toBe(false);
  });

  it('BULLISH (mild) news aligned → +2 bonus', () => {
    const r = composeContextScore({ ...emptyCtx, sentiment: 'BULLISH' }, 'long');
    expect(r.delta).toBe(2);
  });

  it('BEARISH (mild) news against long → no penalty (informational)', () => {
    const r = composeContextScore({ ...emptyCtx, sentiment: 'BEARISH' }, 'long');
    expect(r.delta).toBe(0);
    expect(r.veto).toBe(false);
  });

  it('gap layer contributes zero delta regardless of alignment', () => {
    for (const gap of ['GAP_UP_STRONG', 'GAP_UP', 'FLAT', 'GAP_DOWN', 'GAP_DOWN_STRONG']) {
      for (const dir of ['long', 'short']) {
        const r = composeContextScore({ ...emptyCtx, gap }, dir);
        expect(r.delta, `gap=${gap} dir=${dir}`).toBe(0);
      }
    }
  });

  it('flow layer contributes zero delta regardless of alignment', () => {
    for (const flow of ['STRONG_BUY', 'BUY', 'NEUTRAL', 'SELL', 'STRONG_SELL']) {
      for (const dir of ['long', 'short']) {
        const r = composeContextScore({ ...emptyCtx, flow }, dir);
        expect(r.delta, `flow=${flow} dir=${dir}`).toBe(0);
      }
    }
  });

  it('liquidity layer contributes zero delta (veto-only) for non-D tiers', () => {
    for (const liquidity of ['TIER_A', 'TIER_B', 'TIER_C']) {
      for (const dir of ['long', 'short']) {
        const r = composeContextScore({ ...emptyCtx, liquidity }, dir);
        expect(r.delta, `liq=${liquidity} dir=${dir}`).toBe(0);
        expect(r.veto).toBe(false);
      }
    }
  });

  it('VIX non-LOW regimes contribute zero delta', () => {
    // Non-LOW regimes match CLAUDE.md rule #4 exactly.
    for (const regime of ['NORMAL', 'HIGH']) {
      const r = composeContextScore({ ...emptyCtx, vixRegime: regime }, 'long');
      expect(r.delta, `regime=${regime}`).toBe(0);
    }
  });

  it('VIX LOW contributes +2 — current behavior; CLAUDE.md rule #4 says this should be 0', () => {
    // If this test starts failing because the +2 was changed to 0, the fix
    // aligned the code with CLAUDE.md — GOOD. Flip the assertion to `toBe(0)`
    // AFTER validating on the 17-day sweep. Do NOT remove this test.
    const r = composeContextScore({ ...emptyCtx, vixRegime: 'LOW' }, 'long');
    expect(r.delta).toBe(2);
    expect(r.veto).toBe(false);
  });
});
