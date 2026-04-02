import { isMarginEligible } from '../../data/marginData.js';

/**
 * Touch & Turn scalp variant.
 *
 * PURE RULE-BASED — no confidence scoring. All 3 conditions met = trade.
 *
 * Rules (from transcript):
 * 1. Fibonacci the 15-min opening range (ORB high/low)
 * 2. Confirm liquidity candle (range ≥ 25% of 14-day ATR)
 * 3. Place limit order at range edge OPPOSITE to manipulation direction:
 *    - Red/bearish ORB → BUY when price touches ORB low
 *    - Green/bullish ORB → SELL when price touches ORB high
 * 4. Target: 38.2% Fibonacci level (from edge toward center)
 * 5. SL: half of target distance (gives 2:1 R:R)
 * 6. Only within first 90 minutes
 *
 * Win rate logic: 3 of 4 daily scenarios hit the target:
 *   Scenario 1: Retest before breakout → passes through target → WIN
 *   Scenario 2: Stays in range (bounces) → passes through target → WIN
 *   Scenario 3: Full reversal → passes through target → WIN
 *   Scenario 4: Breaks through on first touch → LOSS
 *
 * === HARD CONSTRAINTS ===
 * - maxHoldBars: 15 (scalp limit)
 */

function _atr(candles, n = 14) {
  if (candles.length < 2) return 0;
  let s = 0;
  const m = Math.min(n, candles.length - 1);
  for (let i = candles.length - m; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    s += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  }
  return s / m;
}

/* ── Pattern Detection ───────────────────────────────────────── */

export function detectPatterns(candles, opts = {}) {
  if (!candles || candles.length < 10) return [];
  const cur = candles[candles.length - 1];
  const barIndex = opts?.barIndex ?? 0;
  const orbHigh = opts?.orbHigh;
  const orbLow = opts?.orbLow;
  if (!orbHigh || !orbLow || orbHigh <= orbLow) return [];

  const orbRange = orbHigh - orbLow;
  const atr14 = _atr(candles);

  // Step 2: Liquidity candle confirmation
  if (atr14 <= 0 || orbRange < atr14 * 0.25) return [];

  // Only within first 90 bars
  if (barIndex > 90) return [];

  // Determine ORB direction
  const orbMid = (orbHigh + orbLow) / 2;
  const firstCandle = candles.length > 20 ? candles[candles.length - barIndex - 1] : null;
  const orbBullish = firstCandle ? firstCandle.c > firstCandle.o : cur.c > orbMid;

  // Touch tolerance: price must be within 3% of ORB range from the edge
  const touchTol = orbRange * 0.03;

  if (!orbBullish) {
    // Red ORB → buy when price touches ORB low
    if (cur.l <= orbLow + touchTol) {
      return [{
        name: 'Touch & Turn Long',
        direction: 'bullish',
        strength: 0.80,
        reliability: 0.75,
        category: 'touch_and_turn',
      }];
    }
  }

  if (orbBullish) {
    // Green ORB → sell when price touches ORB high
    if (cur.h >= orbHigh - touchTol) {
      return [{
        name: 'Touch & Turn Short',
        direction: 'bearish',
        strength: 0.80,
        reliability: 0.75,
        category: 'touch_and_turn',
      }];
    }
  }

  return [];
}

/* ── Liquidity Box ───────────────────────────────────────────── */

export function detectLiquidityBox(candles) {
  return null;
}

/* ── Risk Scoring — rule-based ───────────────────────────────── */

export function computeRiskScore({ candles, patterns, box, opts }) {
  const cur = candles[candles.length - 1];
  const top = patterns?.[0];
  if (!top) return _noTrade(cur);

  const orbHigh = opts?.orbHigh;
  const orbLow = opts?.orbLow;
  if (!orbHigh || !orbLow) return _noTrade(cur);

  const direction = top.direction === 'bearish' ? 'short' : 'long';
  const orbRange = orbHigh - orbLow;

  // Entry at range edge (limit-order style, triggered on touch)
  const entry = direction === 'long' ? orbLow * 1.001 : orbHigh * 0.999;

  // Target: 38.2% Fibonacci level from the edge toward center
  const targetDist = orbRange * 0.382;
  const target = direction === 'long' ? entry + targetDist : entry - targetDist;

  // SL: half of target distance → 2:1 R:R (from transcript)
  const slDist = Math.max(targetDist * 0.5, entry * 0.003);
  const sl = direction === 'long' ? entry - slDist : entry + slDist;

  // Margin eligibility check
  if (opts?.margin && opts?.sym && !isMarginEligible(opts.sym, opts.marginMap)) {
    return _noTrade(cur);
  }

  // All conditions met → trade is ON
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
