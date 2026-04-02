import { isMarginEligible } from '../../data/marginData.js';

/**
 * Box Theory scalp variant.
 *
 * PURE RULE-BASED — no confidence scoring. Conditions met = trade.
 *
 * Rules (from transcript):
 * 1. Draw previous day's high and low as a "box" with midline
 * 2. If price is at/above top of box → SHORT (strongest seller zone)
 * 3. If price is at/below bottom of box → LONG (strongest buyer zone)
 * 4. If price is in the middle → DO NOT TRADE (noise/indecision)
 * 5. Target: midline of box (center)
 * 6. SL: beyond box edge (safety net)
 *
 * "Trading probabilities, not perfection. 70-80% win rate at
 *  the top and bottom of the box."
 *
 * === HARD CONSTRAINTS ===
 * - maxHoldBars: 15 (scalp limit)
 */

const EDGE_PCT = 0.20; // top/bottom 20% of box = trade zone

/* ── Pattern Detection ───────────────────────────────────────── */

export function detectPatterns(candles, opts = {}) {
  if (!candles || candles.length < 5) return [];
  const cur = candles[candles.length - 1];
  const prevHigh = opts?.prevDayHigh;
  const prevLow = opts?.prevDayLow;
  if (!prevHigh || !prevLow || prevHigh <= prevLow) return [];

  const range = prevHigh - prevLow;
  const topZone = prevHigh - range * EDGE_PCT;
  const bottomZone = prevLow + range * EDGE_PCT;

  // Rule: at/above top zone → short
  if (cur.c >= topZone) {
    return [{
      name: 'Box Top Fade',
      direction: 'bearish',
      strength: 0.80,
      reliability: 0.75,
      category: 'box_theory',
    }];
  }

  // Rule: at/below bottom zone → long
  if (cur.c <= bottomZone) {
    return [{
      name: 'Box Bottom Bounce',
      direction: 'bullish',
      strength: 0.80,
      reliability: 0.75,
      category: 'box_theory',
    }];
  }

  // Rule: in the middle → no trade
  return [];
}

/* ── Liquidity Box ───────────────────────────────────────────── */

export function detectLiquidityBox(candles) {
  return null;
}

/* ── Risk Scoring — rule-based, no confidence curve ──────────── */

export function computeRiskScore({ candles, patterns, box, opts }) {
  const cur = candles[candles.length - 1];
  const top = patterns?.[0];
  if (!top) return _noTrade(cur);

  const prevHigh = opts?.prevDayHigh;
  const prevLow = opts?.prevDayLow;
  if (!prevHigh || !prevLow) return _noTrade(cur);

  const range = prevHigh - prevLow;
  const midline = prevLow + range * 0.5;
  const direction = top.direction === 'bearish' ? 'short' : 'long';

  // Entry with slippage
  const entry = direction === 'long' ? cur.c * 1.001 : cur.c * 0.999;

  // Target: midline of box
  const targetDist = direction === 'long'
    ? Math.max(midline - entry, entry * 0.002)
    : Math.max(entry - midline, entry * 0.002);
  const target = direction === 'long' ? entry + targetDist : entry - targetDist;

  // SL: beyond box edge (wide — the box edge IS the support/resistance)
  const slDist = direction === 'long'
    ? Math.max(entry - prevLow + range * 0.05, entry * 0.015)
    : Math.max(prevHigh - entry + range * 0.05, entry * 0.015);
  const sl = direction === 'long' ? entry - slDist : entry + slDist;

  // Margin eligibility check
  if (opts?.margin && opts?.sym && !isMarginEligible(opts.sym, opts.marginMap)) {
    return _noTrade(cur);
  }

  // Conditions met → trade is ON. Fixed high confidence.
  return {
    total: 80, confidence: 85,
    breakdown: { signalClarity: 20, lowNoise: 15, riskReward: 20, patternReliability: 15, confluence: 10 },
    level: 'high',
    action: direction === 'long' ? 'STRONG BUY' : 'STRONG SHORT',
    entry, sl, target,
    rr: targetDist / Math.max(slDist, 1e-9),
    direction,
    context: direction === 'long' ? 'at_support' : 'at_resistance',
    maxHoldBars: 15,
  };
}

function _noTrade(cur) {
  return {
    total: 0, confidence: 20,
    breakdown: { signalClarity: 0, lowNoise: 0, riskReward: 0, patternReliability: 0, confluence: 0 },
    level: 'low', action: 'NO TRADE',
    entry: cur.c, sl: cur.c, target: cur.c, rr: 0, direction: 'long',
    context: 'mid_range', maxHoldBars: 15,
  };
}
