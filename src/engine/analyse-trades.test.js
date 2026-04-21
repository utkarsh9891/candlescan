/**
 * Unit tests for scripts/analyse-trades.mjs — the confidence -> win-rate
 * calibration helper.
 *
 * The script lives under `scripts/` but vitest only picks up tests under
 * `src/**`, so we import across the tree here. The import path points at
 * the .mjs source directly; Node's ESM loader handles it under vitest.
 */
import { describe, it, expect } from 'vitest';
import { bucketTrades } from '../../scripts/analyse-trades.mjs';

/**
 * Build a synthetic trade. Only the fields consumed by `bucketTrades`
 * matter — everything else is stripped so a test failure points at
 * the relevant bucketing logic and not some unrelated schema drift.
 */
function mkTrade({ confidence, netPnl, volFactor, rs, intraPct, vixRegime }) {
  return {
    confidence,
    netPnl,
    features: { volFactor, rs, intraPct },
    contextSnapshot: { vixRegime },
  };
}

describe('bucketTrades — confidence dimension', () => {
  it('groups trades into the documented 70-74 / 75-79 / 80-84 / 85-89 / 90+ bands', () => {
    const trades = [
      // 70-74 band — 1 win / 1 loss, net +100
      mkTrade({ confidence: 70, netPnl: 200 }),
      mkTrade({ confidence: 74, netPnl: -100 }),
      // 75-79 band — 2 wins / 2 losses, net +100
      mkTrade({ confidence: 75, netPnl: 300 }),
      mkTrade({ confidence: 77, netPnl: 200 }),
      mkTrade({ confidence: 78, netPnl: -200 }),
      mkTrade({ confidence: 79, netPnl: -200 }),
      // 80-84 band — 3 wins / 0 losses, net +900 (PF should be Infinity)
      mkTrade({ confidence: 80, netPnl: 300 }),
      mkTrade({ confidence: 82, netPnl: 300 }),
      mkTrade({ confidence: 84, netPnl: 300 }),
      // 85-89 band — 1 win / 1 loss, net -100
      mkTrade({ confidence: 85, netPnl: 400 }),
      mkTrade({ confidence: 89, netPnl: -500 }),
      // 90+ band — 1 win
      mkTrade({ confidence: 95, netPnl: 1000 }),
    ];
    const out = bucketTrades(trades, 'confidence');

    // 70-74
    expect(out['70-74'].n).toBe(2);
    expect(out['70-74'].wins).toBe(1);
    expect(out['70-74'].losses).toBe(1);
    expect(out['70-74'].winRate).toBeCloseTo(0.5);
    expect(out['70-74'].meanPnl).toBeCloseTo(50);
    expect(out['70-74'].sumPnl).toBe(100);
    // PF = 200 / 100 = 2.0
    expect(out['70-74'].profitFactor).toBeCloseTo(2.0);

    // 75-79
    expect(out['75-79'].n).toBe(4);
    expect(out['75-79'].wins).toBe(2);
    expect(out['75-79'].sumPnl).toBe(100);
    expect(out['75-79'].meanPnl).toBeCloseTo(25);
    // PF = 500 / 400 = 1.25
    expect(out['75-79'].profitFactor).toBeCloseTo(1.25);

    // 80-84 — no losses -> Infinity PF
    expect(out['80-84'].n).toBe(3);
    expect(out['80-84'].wins).toBe(3);
    expect(out['80-84'].losses).toBe(0);
    expect(out['80-84'].winRate).toBe(1);
    expect(out['80-84'].sumPnl).toBe(900);
    expect(out['80-84'].profitFactor).toBe(Infinity);

    // 85-89
    expect(out['85-89'].n).toBe(2);
    expect(out['85-89'].sumPnl).toBe(-100);
    expect(out['85-89'].winRate).toBeCloseTo(0.5);

    // 90+
    expect(out['90+'].n).toBe(1);
    expect(out['90+'].wins).toBe(1);
    expect(out['90+'].winRate).toBe(1);
    expect(out['90+'].profitFactor).toBe(Infinity);
  });

  it('classifies null / undefined / out-of-range confidence as "unknown" instead of throwing', () => {
    const trades = [
      mkTrade({ confidence: null, netPnl: 50 }),
      mkTrade({ confidence: undefined, netPnl: -50 }),
      mkTrade({ confidence: 65, netPnl: 10 }), // below lowest band
    ];
    const out = bucketTrades(trades, 'confidence');
    expect(out.unknown.n).toBe(3);
    expect(out.unknown.wins).toBe(2); // 50 and 10 are positive
    expect(out.unknown.sumPnl).toBe(10);
  });
});

describe('bucketTrades — feature-based dimensions', () => {
  it('buckets volFactor / rs / intraPct from trade.features.*', () => {
    const trades = [
      mkTrade({ confidence: 80, netPnl: 100, volFactor: 1.2, rs: 0.8, intraPct: 1.0 }),
      mkTrade({ confidence: 80, netPnl: 200, volFactor: 1.8, rs: 1.3, intraPct: 1.8 }),
      mkTrade({ confidence: 80, netPnl: 300, volFactor: 2.5, rs: 2.0, intraPct: 2.5 }),
      mkTrade({ confidence: 80, netPnl: 400, volFactor: 3.5, rs: 3.0, intraPct: 3.5 }),
    ];
    const vol = bucketTrades(trades, 'volFactor');
    expect(vol['<1.5'].n).toBe(1);
    expect(vol['1.5-2.0'].n).toBe(1);
    expect(vol['2.0-3.0'].n).toBe(1);
    expect(vol['3.0+'].n).toBe(1);

    const rs = bucketTrades(trades, 'rs');
    expect(rs['<1.0'].n).toBe(1);
    expect(rs['1.0-1.5'].n).toBe(1);
    expect(rs['1.5-2.5'].n).toBe(1);
    expect(rs['2.5+'].n).toBe(1);

    const intra = bucketTrades(trades, 'intraPct');
    expect(intra['<1.5'].n).toBe(1);
    expect(intra['1.5-2.0'].n).toBe(1);
    expect(intra['2.0-3.0'].n).toBe(1);
    expect(intra['3.0+'].n).toBe(1);
  });
});

describe('bucketTrades — vixRegime', () => {
  it('groups LOW / MED / HIGH categorically and falls back to unknown', () => {
    const trades = [
      mkTrade({ confidence: 80, netPnl: 10, vixRegime: 'LOW' }),
      mkTrade({ confidence: 80, netPnl: 20, vixRegime: 'LOW' }),
      mkTrade({ confidence: 80, netPnl: -5, vixRegime: 'MED' }),
      mkTrade({ confidence: 80, netPnl: 30, vixRegime: 'HIGH' }),
      mkTrade({ confidence: 80, netPnl: 40, vixRegime: 'UNKNOWN' }), // not a documented value
      mkTrade({ confidence: 80, netPnl: 50, vixRegime: null }),
    ];
    const out = bucketTrades(trades, 'vixRegime');
    expect(out.LOW.n).toBe(2);
    expect(out.LOW.sumPnl).toBe(30);
    expect(out.MED.n).toBe(1);
    expect(out.HIGH.n).toBe(1);
    // "UNKNOWN" string and null both fall through to `unknown`
    expect(out.unknown.n).toBe(2);
    expect(out.unknown.sumPnl).toBe(90);
  });
});
