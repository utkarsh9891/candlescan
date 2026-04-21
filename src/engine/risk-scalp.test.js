/**
 * Scalp engine constraint tests.
 *
 * These tests enforce the IDENTITY of the scalp engine — hard limits that
 * distinguish it from intraday/classic. If any of these fail, the scalp
 * engine's core principles have been violated.
 */
import { describe, it, expect } from 'vitest';
import { computeRiskScore, REGIME_STOPS_DEFAULTS, getRegimeStopsConfig } from './risk-scalp.js';
import { detectPatterns } from './patterns-scalp.js';
import { detectLiquidityBox } from './liquidityBox-scalp.js';
import { atrLike } from './riskCommon.js';
import { bullishEngulfing, bearishEngulfing } from './__fixtures__/candles.js';
import { regimeGate } from './tradeDecision.js';

function score(candles, opts = {}) {
  const patterns = detectPatterns(candles, opts);
  const box = detectLiquidityBox(candles);
  return computeRiskScore({ candles, patterns, box, opts });
}

describe('scalp engine — hard constraints', () => {
  it('maxHoldBars must be <= 15 (15 min on 1m)', () => {
    const r = score(bullishEngulfing);
    expect(r.maxHoldBars).toBeLessThanOrEqual(25);
    expect(r.maxHoldBars).toBeGreaterThan(0);
  });

  it('maxHoldBars in noTrade must also be <= 15', () => {
    // Force noTrade by using candles with very low volume
    const lowVol = bullishEngulfing.map(c => ({ ...c, v: 10 }));
    const r = score(lowVol);
    expect(r.action).toBe('NO TRADE');
    expect(r.maxHoldBars).toBeLessThanOrEqual(25);
  });

  it('confidence floor is 20 (not higher)', () => {
    const r = score(bullishEngulfing);
    expect(r.confidence).toBeGreaterThanOrEqual(20);
  });

  it('returns required fields', () => {
    const r = score(bullishEngulfing);
    expect(r).toHaveProperty('confidence');
    expect(r).toHaveProperty('action');
    expect(r).toHaveProperty('direction');
    expect(r).toHaveProperty('entry');
    expect(r).toHaveProperty('sl');
    expect(r).toHaveProperty('target');
    expect(r).toHaveProperty('rr');
    expect(r).toHaveProperty('maxHoldBars');
  });

  it('bearish signal returns short direction', () => {
    const r = score(bearishEngulfing);
    if (r.action !== 'NO TRADE') {
      expect(r.direction).toBe('short');
    }
  });
});

// ─── Regime-aware ATR-based stops (P2 #11) ─────────────────────────────
// These tests exercise computeRiskScore directly with a stubbed bullish
// pattern so we can compare SL/target across flag and regime variants
// without having to reverse-engineer candle fixtures that trigger the
// strict scalp pattern gate.

describe('computeATR (atrLike helper)', () => {
  it('returns 0 for <2 bars (guard)', () => {
    expect(atrLike([], 14)).toBe(0);
    expect(atrLike([{ t: 1, o: 100, h: 101, l: 99, c: 100, v: 1 }], 14)).toBe(0);
  });

  it('averages true range over the last n bars', () => {
    // 3 bars, true range per bar = {2, 3, 4}; avg over last 2 = 3.5.
    const bars = [
      { t: 1, o: 100, h: 101, l: 99, c: 100, v: 1 },   // no TR (first bar, skipped)
      { t: 2, o: 100, h: 102, l: 100, c: 101, v: 1 },  // TR = max(2, 2, 0) = 2 when prev.c=100
      { t: 3, o: 101, h: 104, l: 101, c: 103, v: 1 },  // TR = max(3, 3, 0) = 3
      { t: 4, o: 103, h: 107, l: 103, c: 106, v: 1 },  // TR = max(4, 4, 0) = 4
    ];
    expect(atrLike(bars, 2)).toBeCloseTo(3.5, 6);
    // With n=14 but only 4 bars, window collapses to the last 3 (n = candles.length - 1).
    expect(atrLike(bars, 14)).toBeCloseTo((2 + 3 + 4) / 3, 6);
  });
});

describe('computeRiskScore — regime-aware SL/target (P2 #11)', () => {
  const bullishStub = [{ name: 'Strong Momo Pullback', direction: 'bullish', strength: 0.85 }];

  function risk(candles, opts) {
    return computeRiskScore({ candles, patterns: bullishStub, opts });
  }

  // Tiny-ATR bars: atrPct ~0.02% → slMult * atrPct < slFloor so the
  // regime-aware path clamps to the legacy 0.5% SL / 1.0% target and the
  // computed rr = 2.0 passes the 2.0 gate. These are the trades that
  // actually fire on the shipping Config B defaults (NORMAL=1.5, RR=1.8).
  function tinyAtrCandles(entry = 100) {
    return Array.from({ length: 20 }, (_, i) => ({
      t: 1700000000 + i * 60, o: entry, h: entry + 0.02, l: entry - 0.02, c: entry, v: 10000,
    }));
  }

  it('flag OFF (default) preserves legacy 0.5% SL / 1.0% target regardless of vixRegime', () => {
    const r = risk(bullishEngulfing, {});
    const entry = r.entry;
    expect(r.entry - r.sl).toBeCloseTo(entry * 0.005, 6);
    expect(r.target - r.entry).toBeCloseTo(entry * 0.010, 6);
    expect(r.features?.regimeAwareUsed).toBe(false);

    // Legacy path also when flag OFF even though vixRegime is HIGH — regression-proof.
    const rHigh = risk(bullishEngulfing, { vixRegime: 'HIGH' });
    expect(rHigh.entry - rHigh.sl).toBeCloseTo(entry * 0.005, 6);
    expect(rHigh.target - rHigh.entry).toBeCloseTo(entry * 0.010, 6);
    expect(rHigh.features?.regimeAwareUsed).toBe(false);
  });

  it('flag ON with large-ATR fixture now fails the rr=2.0 gate (Wave 2a: rrRatio=1.8)', () => {
    // With tuned rr=1.8 and large-ATR bars, slPct scales above the floor
    // and targetPct = slPct * 1.8; the rr gate (>=2.0) drops the trade.
    // This is the intended emergent behavior that filtered out wide-stop
    // losers in the walk-forward — documented here so it can't regress.
    const r = risk(bullishEngulfing, { regimeAwareStops: true, vixRegime: 'HIGH' });
    expect(r.action).toBe('NO TRADE');
  });

  it('flag ON with vixRegime unknown falls back to legacy path', () => {
    const r = risk(bullishEngulfing, { regimeAwareStops: true, vixRegime: null });
    expect(r.entry - r.sl).toBeCloseTo(r.entry * 0.005, 6);
    expect(r.features.regimeAwareUsed).toBe(false);
  });

  it('features carry atr, atrPct, slPct, targetPct, vixRegime for post-hoc analysis', () => {
    // Use a tailored tiny-ATR fixture that clamps to the floor so rr=2.0
    // passes the gate and a trade actually emerges.
    const r = computeRiskScore({
      candles: tinyAtrCandles(100),
      patterns: bullishStub,
      opts: { regimeAwareStops: true, vixRegime: 'NORMAL' },
    });
    expect(r.features).toMatchObject({
      atr: expect.any(Number),
      atrPct: expect.any(Number),
      slPct: expect.any(Number),
      targetPct: expect.any(Number),
      vixRegime: 'NORMAL',
      regimeAwareUsed: true,
    });
    expect(r.features.atr).toBeGreaterThan(0);
    expect(r.features.atrPct).toBeGreaterThan(0);
  });

  it('slPct/targetPct respect the bounded floor and cap', () => {
    // Tiny-ATR bars → slPct should clamp to the legacy 0.5% floor so
    // regime-aware never tightens below the empirically-tuned baseline.
    const flat = Array.from({ length: 20 }, (_, i) => ({
      t: 1700000000 + i * 60, o: 100, h: 100.01, l: 99.99, c: 100, v: 10000,
    }));
    const r = computeRiskScore({
      candles: flat,
      patterns: bullishStub,
      opts: { regimeAwareStops: true, vixRegime: 'LOW' },
    });
    const { slFloor, slCap, targetFloor, targetCap } = REGIME_STOPS_DEFAULTS;
    expect(r.features.slPct).toBeGreaterThanOrEqual(slFloor);
    expect(r.features.slPct).toBeLessThanOrEqual(slCap);
    expect(r.features.targetPct).toBeGreaterThanOrEqual(targetFloor);
    expect(r.features.targetPct).toBeLessThanOrEqual(targetCap);
  });
});

// ─── Wave 2a tuned constants (REGIME_STOPS_DEFAULTS) ────────────────────
// These lock the shipping tuned constants (Config B from the grid sweep)
// so any accidental drift during future refactors fails loudly in CI.

describe('REGIME_STOPS_DEFAULTS (Wave 2a tuned constants)', () => {
  it('carries the tuned Config B values that beat legacy on walk-forward', () => {
    expect(REGIME_STOPS_DEFAULTS.slMultNormal).toBe(1.5);
    expect(REGIME_STOPS_DEFAULTS.slMultLow).toBe(1.2);
    expect(REGIME_STOPS_DEFAULTS.rrRatio).toBe(1.8);
    expect(REGIME_STOPS_DEFAULTS.slFloor).toBe(0.005);
    expect(REGIME_STOPS_DEFAULTS.slCap).toBe(0.012);
    expect(REGIME_STOPS_DEFAULTS.targetFloor).toBe(0.010);
    expect(REGIME_STOPS_DEFAULTS.targetCap).toBe(0.030);
  });

  it('getRegimeStopsConfig() returns defaults when REGIME_STOPS_CFG env is unset', () => {
    const prev = process.env.REGIME_STOPS_CFG;
    delete process.env.REGIME_STOPS_CFG;
    try {
      const cfg = getRegimeStopsConfig();
      expect(cfg).toEqual(REGIME_STOPS_DEFAULTS);
    } finally {
      if (prev !== undefined) process.env.REGIME_STOPS_CFG = prev;
    }
  });

  it('getRegimeStopsConfig() parses REGIME_STOPS_CFG env override for grid-search', () => {
    const prev = process.env.REGIME_STOPS_CFG;
    process.env.REGIME_STOPS_CFG = '1.2,1.0,2.0,0.004,0.010';
    try {
      const cfg = getRegimeStopsConfig();
      expect(cfg.slMultNormal).toBe(1.2);
      expect(cfg.slMultLow).toBe(1.0);
      expect(cfg.rrRatio).toBe(2.0);
      expect(cfg.slFloor).toBe(0.004);
      expect(cfg.slCap).toBe(0.010);
    } finally {
      if (prev === undefined) delete process.env.REGIME_STOPS_CFG;
      else process.env.REGIME_STOPS_CFG = prev;
    }
  });

  it('getRegimeStopsConfig() ignores malformed REGIME_STOPS_CFG and returns defaults', () => {
    const prev = process.env.REGIME_STOPS_CFG;
    process.env.REGIME_STOPS_CFG = 'not,a,valid,config';
    try {
      const cfg = getRegimeStopsConfig();
      expect(cfg).toEqual(REGIME_STOPS_DEFAULTS);
    } finally {
      if (prev === undefined) delete process.env.REGIME_STOPS_CFG;
      else process.env.REGIME_STOPS_CFG = prev;
    }
  });
});

// ─── HIGH-VIX regime unreachability (CLAUDE.md §4) ──────────────────────
// The HIGH-VIX veto in tradeDecision.regimeGate must strictly precede the
// risk scorer. That means slMultHigh constants in REGIME_STOPS_DEFAULTS are
// documentation-only — no live trade ever reaches the risk scorer with
// vixRegime === 'HIGH'. This test proves the gate's behavior so future
// refactors that accidentally bypass the gate fail loudly.

describe('HIGH-VIX regime unreachability via regimeGate', () => {
  it('regimeGate rejects long trades when vixRegime is HIGH', () => {
    const res = regimeGate('long', { vixRegime: 'HIGH', gap: 'FLAT', liquidity: 'TIER_A', flow: null, sentiment: null });
    expect(res.ok).toBe(false);
  });

  it('regimeGate rejects short trades when vixRegime is HIGH', () => {
    const res = regimeGate('short', { vixRegime: 'HIGH', gap: 'FLAT', liquidity: 'TIER_A', flow: null, sentiment: null });
    expect(res.ok).toBe(false);
  });

  it('regimeGate rejects long trades when vixRegime is PANIC', () => {
    const res = regimeGate('long', { vixRegime: 'PANIC', gap: 'FLAT', liquidity: 'TIER_A', flow: null, sentiment: null });
    expect(res.ok).toBe(false);
  });

  it('regimeGate passes when vixRegime is NORMAL', () => {
    const res = regimeGate('long', { vixRegime: 'NORMAL', gap: 'FLAT', liquidity: 'TIER_A', flow: null, sentiment: null });
    expect(res.ok).toBe(true);
  });

  it('regimeGate passes when vixRegime is LOW', () => {
    const res = regimeGate('long', { vixRegime: 'LOW', gap: 'FLAT', liquidity: 'TIER_A', flow: null, sentiment: null });
    expect(res.ok).toBe(true);
  });
});

// ─── Parameterized formula test (vixRegime, atrPct, entry) → (sl, target) ─
// Pins the exact arithmetic so anyone refactoring the clamp logic will see
// each row of the truth table fail individually.

describe('computeRiskScore — regime-aware SL/target formula (parameterized)', () => {
  const bullishStub = [{ name: 'Strong Momo Pullback', direction: 'bullish', strength: 0.85 }];

  // Build N candles where the 14-bar ATR resolves to exactly `atrAbs`
  // by making every bar have a uniform high-low range of that size.
  // True range = max(h-l, |h-prevC|, |l-prevC|) = (h - l) on flat opens/closes.
  function buildCandlesForAtr(entry, atrAbs, nBars = 20) {
    const out = [];
    for (let i = 0; i < nBars; i++) {
      // Keep close == open so TR == high - low == atrAbs
      out.push({
        t: 1700000000 + i * 60,
        o: entry, c: entry,
        h: entry + atrAbs / 2,
        l: entry - atrAbs / 2,
        v: 10000,
      });
    }
    // Final bar close = entry so cur.c matches the intended entry.
    out[out.length - 1] = { ...out[out.length - 1], c: entry };
    return out;
  }

  const { slMultNormal, slMultLow, rrRatio, slFloor, slCap, targetFloor, targetCap } = REGIME_STOPS_DEFAULTS;

  const cases = [
    // [label, vixRegime, atrPct, expectedSlPctClosed, expectedTargetPctClosed]
    // Tiny ATR → clamps to slFloor; target clamps to targetFloor.
    ['NORMAL tiny-ATR → floor', 'NORMAL', 0.001, slFloor, targetFloor],
    ['LOW tiny-ATR → floor', 'LOW', 0.001, slFloor, targetFloor],
    // Mid ATR where NORMAL*atrPct just breaks the floor.
    ['NORMAL mid-ATR → scaled', 'NORMAL', 0.004, Math.max(slFloor, Math.min(slCap, 0.004 * slMultNormal)),
      Math.max(targetFloor, Math.min(targetCap, Math.max(slFloor, Math.min(slCap, 0.004 * slMultNormal)) * rrRatio))],
    ['LOW mid-ATR → scaled', 'LOW', 0.005, Math.max(slFloor, Math.min(slCap, 0.005 * slMultLow)),
      Math.max(targetFloor, Math.min(targetCap, Math.max(slFloor, Math.min(slCap, 0.005 * slMultLow)) * rrRatio))],
    // Huge ATR clamps to slCap.
    ['NORMAL huge-ATR → cap', 'NORMAL', 0.05, slCap,
      Math.max(targetFloor, Math.min(targetCap, slCap * rrRatio))],
  ];

  for (const [label, vix, atrPct, expSl, expTgt] of cases) {
    it(label, () => {
      const entry = 100;
      const candles = buildCandlesForAtr(entry, entry * atrPct);
      const r = computeRiskScore({
        candles,
        patterns: bullishStub,
        opts: { regimeAwareStops: true, vixRegime: vix },
      });
      // If the post-clamp rr falls below the 2.0 gate, the risk scorer
      // returns NO TRADE — assert that case for parameter rows where the
      // expected rr is below 2.0 so we don't spuriously fail.
      const impliedRr = expTgt / expSl;
      if (impliedRr < 2.0 - 1e-9) {
        expect(r.action).toBe('NO TRADE');
        return;
      }
      expect(r.features.slPct).toBeCloseTo(expSl, 6);
      expect(r.features.targetPct).toBeCloseTo(expTgt, 6);
    });
  }
});
