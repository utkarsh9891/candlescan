/**
 * Touch & Turn scalp variant.
 *
 * Strategy (3 steps):
 * 1. Fibonacci the 15-min opening range (ORB high/low)
 * 2. Confirm liquidity candle (range ≥ 25% of 14-day ATR)
 * 3. Place limit order at range edge OPPOSITE to manipulation direction
 *    - Red ORB → buy at ORB low (touch and turn up)
 *    - Green ORB → sell at ORB high (touch and turn down)
 *    - Target: 38.2% Fibonacci level
 *    - SL: half of target distance (2:1 R:R)
 *
 * Win rate logic: 3 of 4 daily scenarios pass through the target:
 *   1. Price retests range edge before breaking through → WIN
 *   2. Price stays within range (bounces) → WIN
 *   3. Full reversal → WIN
 *   4. Price breaks through on first touch → LOSS (only losing scenario)
 *
 * Source: "Touch and Turn Scalper" — limit order at range edge with fib target.
 *
 * === HARD CONSTRAINTS ===
 * - maxHoldBars: 15 (scalp limit)
 * - Timeframe: 1m
 */

import { atrLike, isLiquidityCandle, fibLevels, avgVolume, noTrade, buildConfidence, confidenceToAction } from './shared.js';

/* ── Pattern Detection ───────────────────────────────────────── */

export function detectPatterns(candles, opts = {}) {
  if (!candles || candles.length < 10) return [];
  const cur = candles[candles.length - 1];
  const barIndex = opts?.barIndex ?? 0;
  const orbHigh = opts?.orbHigh;
  const orbLow = opts?.orbLow;
  if (!orbHigh || !orbLow || orbHigh <= orbLow) return [];

  const orbRange = orbHigh - orbLow;
  const atr14 = atrLike(candles, 14);

  // Step 2: Confirm liquidity candle
  if (!isLiquidityCandle(orbRange, atr14)) return [];

  // Only within first 90 bars
  if (barIndex > 90) return [];

  // Determine ORB direction (same heuristic as Quick Flip)
  const orbMid = (orbHigh + orbLow) / 2;
  const firstBars = candles.slice(-Math.min(candles.length, barIndex + 1));
  const orbFirstBar = firstBars.length > 15 ? firstBars[firstBars.length - barIndex] : null;
  const orbDirection = orbFirstBar ? (orbFirstBar.c > orbFirstBar.o ? 'bullish' : 'bearish') : (cur.c > orbMid ? 'bullish' : 'bearish');

  const patterns = [];

  // Touch and Turn: price touches range edge opposite to manipulation
  const touchTolerance = orbRange * 0.05; // 5% of range tolerance for "touching"

  if (orbDirection === 'bearish') {
    // Red ORB → buy when price touches/near ORB low
    if (cur.c <= orbLow + touchTolerance) {
      const proximity = Math.min(1, Math.max(0, 1 - (cur.c - orbLow) / touchTolerance));
      patterns.push({
        name: 'Touch & Turn (Long)',
        direction: 'bullish',
        strength: 0.70 + proximity * 0.25,
        reliability: 0.75,
        category: 'touch_and_turn',
      });
    }
  }

  if (orbDirection === 'bullish') {
    // Green ORB → sell when price touches/near ORB high
    if (cur.c >= orbHigh - touchTolerance) {
      const proximity = Math.min(1, Math.max(0, 1 - (orbHigh - cur.c) / touchTolerance));
      patterns.push({
        name: 'Touch & Turn (Short)',
        direction: 'bearish',
        strength: 0.70 + proximity * 0.25,
        reliability: 0.75,
        category: 'touch_and_turn',
      });
    }
  }

  return patterns;
}

/* ── Liquidity Box ───────────────────────────────────────────── */

export function detectLiquidityBox(candles) {
  return null; // Touch & Turn uses ORB + Fibonacci directly
}

/* ── Risk Scoring ────────────────────────────────────────────── */

export function computeRiskScore({ candles, patterns, box, opts }) {
  const cur = candles[candles.length - 1];
  const top = patterns?.[0];
  if (!top) return noTrade(cur, candles);

  const orbHigh = opts?.orbHigh;
  const orbLow = opts?.orbLow;
  if (!orbHigh || !orbLow) return noTrade(cur, candles);

  // Volume gate
  const vol = avgVolume(candles, 10);
  if (vol < 5000) return noTrade(cur, candles);

  const direction = top.direction === 'bearish' ? 'short' : 'long';
  const entry = direction === 'long' ? cur.c * 1.0015 : cur.c * 0.9985;

  // Fibonacci levels
  const fib = fibLevels(orbHigh, orbLow);

  // Target: 38.2% fib level (from the edge toward center)
  let targetPrice;
  if (direction === 'long') {
    targetPrice = fib.fib382; // from low toward 38.2% = low + 38.2% of range
    if (targetPrice <= entry) targetPrice = entry + (orbHigh - orbLow) * 0.382;
  } else {
    targetPrice = fib.fib618; // from high toward 61.8% = high - 38.2% of range
    if (targetPrice >= entry) targetPrice = entry - (orbHigh - orbLow) * 0.382;
  }

  const targetDist = Math.abs(targetPrice - entry);

  // SL: half of target distance (2:1 R:R)
  const slDist = Math.max(targetDist * 0.5, entry * 0.003);

  const sl = direction === 'long' ? entry - slDist : entry + slDist;
  const target = direction === 'long' ? entry + targetDist : entry - targetDist;
  const rr = targetDist / Math.max(slDist, 1e-9);

  // Score
  const signalClarity = Math.min(25, top.strength * 25);
  const patternRel = top.reliability * 15;
  const rrScore = 22; // 2:1 R:R is excellent

  // Touch confirmation: multiple touches = stronger
  const touchCount = candles.slice(-10).filter(c =>
    direction === 'long' ? c.l <= orbLow + (orbHigh - orbLow) * 0.05 : c.h >= orbHigh - (orbHigh - orbLow) * 0.05
  ).length;
  const touchBonus = Math.min(10, touchCount * 3);

  const raw = signalClarity + rrScore + patternRel + touchBonus;
  const confidence = buildConfidence(raw);
  const action = confidenceToAction(confidence, direction);

  return {
    total: Math.round(raw), confidence,
    breakdown: { signalClarity: Math.round(signalClarity), lowNoise: 0, riskReward: rrScore, patternReliability: Math.round(patternRel), confluence: touchBonus },
    level: confidence >= 75 ? 'high' : confidence >= 60 ? 'moderate' : 'low',
    action, entry, sl, target, rr, direction,
    context: direction === 'long' ? 'at_support' : 'at_resistance',
    maxHoldBars: 15,
  };
}
