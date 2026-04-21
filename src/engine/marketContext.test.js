/**
 * Guard tests for marketContext — the multi-factor composer.
 *
 * Pins the behaviors CLAUDE.md rule #4 cares about:
 *   - Layers can VETO a trade.
 *   - News sentiment (the strongest-predictive layer) can give +2 / +5
 *     confidence bonuses when aligned with the trade direction.
 *   - Other layers (VIX, gap, liquidity, flow) contribute NO positive
 *     delta — they're either informational, penalty-only, or veto-only.
 *
 * Reconciled 2026-04-21 (P1 #9): vixConfidenceDelta('LOW') and
 * liquidityConfidenceDelta('TIER_A') were +2, now 0. HIGH-VIX is now a
 * hard veto in `regimeGate` (see tradeDecision.test / integration).
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
  liquidityConfidenceDelta,
  classifyInstitutionalFlow,
  flowAlignment,
  classifyNewsSentiment,
  newsAlignment,
  composeContextScore,
} from './marketContext.js';
import { regimeGate } from './tradeDecision.js';

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

  it('VIX regimes contribute zero delta (CLAUDE.md §4 reconciled 2026-04-21)', () => {
    for (const regime of ['LOW', 'NORMAL', 'HIGH']) {
      const r = composeContextScore({ ...emptyCtx, vixRegime: regime }, 'long');
      expect(r.delta, `regime=${regime}`).toBe(0);
    }
  });
});

describe('marketContext — delta flattening (P1 #9 reconcile)', () => {
  it('vixConfidenceDelta returns 0 for LOW (was +2 before 2026-04-21)', () => {
    expect(vixConfidenceDelta('LOW')).toBe(0);
    expect(vixConfidenceDelta('NORMAL')).toBe(0);
    expect(vixConfidenceDelta('HIGH')).toBe(0);
    // PANIC remains a defensive floor; real stop is regimeGate
    expect(vixConfidenceDelta('PANIC')).toBeLessThan(0);
  });

  it('liquidityConfidenceDelta returns 0 for TIER_A (was +2 before 2026-04-21)', () => {
    expect(liquidityConfidenceDelta('TIER_A')).toBe(0);
    expect(liquidityConfidenceDelta('TIER_B')).toBe(0);
    // Negative penalties kept — these are vetoes / penalties, not ranking bonuses
    expect(liquidityConfidenceDelta('TIER_C')).toBeLessThan(0);
    expect(liquidityConfidenceDelta('TIER_D')).toBeLessThan(0);
  });

  it('no non-news layer returns a positive delta', () => {
    for (const r of ['LOW', 'NORMAL', 'HIGH', 'PANIC']) {
      expect(vixConfidenceDelta(r), `vix=${r}`).toBeLessThanOrEqual(0);
    }
    for (const t of ['TIER_A', 'TIER_B', 'TIER_C', 'TIER_D']) {
      expect(liquidityConfidenceDelta(t), `liq=${t}`).toBeLessThanOrEqual(0);
    }
  });
});

describe('regimeGate — HIGH-VIX veto (empirical 2026-04-21)', () => {
  it('HIGH-VIX regime blocks the trade with reason "vix-high-veto"', () => {
    const res = regimeGate('long', { vixRegime: 'HIGH' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('vix-high-veto');
  });

  it('HIGH-VIX veto fires regardless of direction', () => {
    expect(regimeGate('long', { vixRegime: 'HIGH' }).ok).toBe(false);
    expect(regimeGate('short', { vixRegime: 'HIGH' }).ok).toBe(false);
  });

  it('non-HIGH regimes still pass the gate (absent other vetoes)', () => {
    expect(regimeGate('long', { vixRegime: 'LOW' }).ok).toBe(true);
    expect(regimeGate('long', { vixRegime: 'NORMAL' }).ok).toBe(true);
  });

  it('PANIC still vetoes with its pre-existing reason (vix=PANIC)', () => {
    const res = regimeGate('long', { vixRegime: 'PANIC' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('vix=PANIC');
  });
});
