/**
 * Quick Flip scalp variant.
 *
 * Strategy (3 steps):
 * 1. Box the 15-min opening range candle (ORB high/low)
 * 2. Confirm it's a "liquidity candle" (range ≥ 25% of 14-day ATR)
 * 3. Wait for reversal candlestick (hammer/engulfing) OUTSIDE the range
 *    - Green ORB → look for bearish reversal above range → short
 *    - Red ORB → look for bullish reversal below range → long
 *    - Target: opposite end of ORB range
 *    - Only within first 90 bars (90 min on 1m)
 *
 * Source: "Quick Flip Scalper" — fade the opening range manipulation.
 *
 * === HARD CONSTRAINTS ===
 * - maxHoldBars: 15 (scalp limit)
 * - Timeframe: 1m
 */

import { atrLike, isLiquidityCandle, detectHammer, detectEngulfing, avgVolume, noTrade, buildConfidence, confidenceToAction } from './shared.js';

/* ── Pattern Detection ───────────────────────────────────────── */

export function detectPatterns(candles, opts = {}) {
  if (!candles || candles.length < 10) return [];
  const cur = candles[candles.length - 1];
  const barIndex = opts?.barIndex ?? 0;
  const orbHigh = opts?.orbHigh;
  const orbLow = opts?.orbLow;
  if (!orbHigh || !orbLow || orbHigh <= orbLow) return [];

  const orbRange = orbHigh - orbLow;

  // ATR from prior candles (use all available, typically prior day + pre-window)
  const atr14 = atrLike(candles, 14);

  // Step 2: Confirm liquidity candle
  if (!isLiquidityCandle(orbRange, atr14)) return [];

  // Only within first 90 bars of window (90 minutes on 1m)
  if (barIndex > 90) return [];

  // Determine ORB direction from first few candles
  // Use orbHigh/orbLow and the pre-window candles to infer direction
  // If price started low and ORB high was the close → bullish ORB
  // Simplified: if current price > ORB midpoint at formation time → bullish ORB
  const orbMid = (orbHigh + orbLow) / 2;
  // We need to determine ORB direction. Use the first bar close vs open of the day.
  // Look for the bar closest to ORB formation.
  const firstBars = candles.slice(-Math.min(candles.length, barIndex + 1));
  const orbFirstBar = firstBars.length > 15 ? firstBars[firstBars.length - barIndex] : null;
  const orbDirection = orbFirstBar ? (orbFirstBar.c > orbFirstBar.o ? 'bullish' : 'bearish') : (cur.c > orbMid ? 'bullish' : 'bearish');

  const patterns = [];

  // Step 3: Look for reversal candles OUTSIDE the range
  if (orbDirection === 'bullish' && cur.c > orbHigh) {
    // Green ORB, price above range → look for bearish reversal
    const hammer = detectHammer(candles);
    const engulf = detectEngulfing(candles);

    if (hammer && hammer.direction === 'bearish') {
      patterns.push({
        name: 'Quick Flip — Inverted Hammer',
        direction: 'bearish',
        strength: 0.65 + hammer.strength * 0.30,
        reliability: 0.70,
        category: 'quick_flip',
      });
    }
    if (engulf && engulf.direction === 'bearish') {
      patterns.push({
        name: 'Quick Flip — Bearish Engulfing',
        direction: 'bearish',
        strength: 0.70 + engulf.strength * 0.25,
        reliability: 0.73,
        category: 'quick_flip',
      });
    }
  }

  if (orbDirection === 'bearish' && cur.c < orbLow) {
    // Red ORB, price below range → look for bullish reversal
    const hammer = detectHammer(candles);
    const engulf = detectEngulfing(candles);

    if (hammer && hammer.direction === 'bullish') {
      patterns.push({
        name: 'Quick Flip — Hammer',
        direction: 'bullish',
        strength: 0.65 + hammer.strength * 0.30,
        reliability: 0.70,
        category: 'quick_flip',
      });
    }
    if (engulf && engulf.direction === 'bullish') {
      patterns.push({
        name: 'Quick Flip — Bullish Engulfing',
        direction: 'bullish',
        strength: 0.70 + engulf.strength * 0.25,
        reliability: 0.73,
        category: 'quick_flip',
      });
    }
  }

  return patterns;
}

/* ── Liquidity Box ───────────────────────────────────────────── */

export function detectLiquidityBox(candles) {
  return null; // Quick Flip uses ORB directly, no micro-consolidation
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

  // Target: opposite end of ORB range
  const targetDist = direction === 'long'
    ? Math.max(orbHigh - entry, entry * 0.003)
    : Math.max(entry - orbLow, entry * 0.003);

  // SL: beyond the reversal candle extreme (wide safety net)
  const atrVal = atrLike(candles, 14);
  const slDist = Math.max(atrVal * 2.0, entry * 0.015);

  const sl = direction === 'long' ? entry - slDist : entry + slDist;
  const target = direction === 'long' ? entry + targetDist : entry - targetDist;
  const rr = targetDist / Math.max(slDist, 1e-9);

  // Score
  const signalClarity = Math.min(25, top.strength * 25);
  const patternRel = top.reliability * 15;
  const rrScore = Math.min(25, Math.round(25 * (1 - Math.exp(-1.5 * Math.max(0.3, rr)))));

  // Liquidity candle strength bonus
  const orbRange = orbHigh - orbLow;
  const lcStrength = Math.min(10, (orbRange / (atrVal * 0.25)) * 3);

  const raw = signalClarity + rrScore + patternRel + lcStrength;
  const confidence = buildConfidence(raw);
  const action = confidenceToAction(confidence, direction);

  return {
    total: Math.round(raw), confidence,
    breakdown: { signalClarity: Math.round(signalClarity), lowNoise: 0, riskReward: rrScore, patternReliability: Math.round(patternRel), confluence: Math.round(lcStrength) },
    level: confidence >= 75 ? 'high' : confidence >= 60 ? 'moderate' : 'low',
    action, entry, sl, target, rr, direction,
    context: direction === 'long' ? 'at_support' : 'at_resistance',
    maxHoldBars: 15,
  };
}
