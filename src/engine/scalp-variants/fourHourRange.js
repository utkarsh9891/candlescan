/**
 * 4-Hour Range scalp variant.
 *
 * Strategy (3 steps):
 * 1. Mark the high/low of the first 4-hour candle of the day
 * 2. On 1m chart, wait for candle to CLOSE outside range (body, not wick)
 * 3. Wait for candle to CLOSE back inside range → reversal signal
 *    - Break above + reentry → short
 *    - Break below + reentry → long
 *    - SL: at breakout extreme
 *    - Target: 2× risk distance
 *
 * Source: "4-Hour Range Strategy" — breakout/reentry mean reversion.
 *
 * === HARD CONSTRAINTS ===
 * - maxHoldBars: 15 (scalp limit)
 * - Timeframe: 1m
 */

import { atrLike, avgVolume, noTrade, buildConfidence, confidenceToAction } from './shared.js';

// State tracked across bars via opts.variantState
// { phase: 'waiting'|'broke_above'|'broke_below', breakoutExtreme: number, rangeHigh, rangeLow }

/* ── Pattern Detection ───────────────────────────────────────── */

export function detectPatterns(candles, opts = {}) {
  if (!candles || candles.length < 30) return [];
  const cur = candles[candles.length - 1];
  const barIndex = opts?.barIndex ?? 0;

  // Compute 4H range from day candles (first 240 1-min bars)
  // In simulation, dayCandles include all bars from market open.
  // We use orbHigh/orbLow as a proxy for the first portion of the day.
  // For a true 4H range, we'd need 240 bars, but in a 90-min window (09:30-11:00),
  // the "4H range" maps naturally to the full pre-window + early window data.
  // Use prevDayHigh/Low as the range if available (broader range),
  // or fall back to ORB for the opening range.
  let rangeHigh = opts?.orbHigh;
  let rangeLow = opts?.orbLow;

  // Prefer a wider range if prev day data is available
  // The 4H range concept: use the first major candle's range
  if (!rangeHigh || !rangeLow) return [];

  const rangeSize = rangeHigh - rangeLow;
  if (rangeSize <= 0) return [];

  const patterns = [];

  // Check for breakout + reentry sequence
  // We look at the last few candles for the pattern:
  // 1. A candle that closed outside the range (body, not just wick)
  // 2. Current candle closes back inside the range

  const lookback = Math.min(15, candles.length - 1);
  let brokeAbove = false;
  let brokeBelowVal = false;
  let breakoutExtreme = 0;

  for (let i = candles.length - lookback; i < candles.length - 1; i++) {
    const bar = candles[i];
    // Body close outside range (not just wick)
    if (bar.c > rangeHigh && bar.o <= rangeHigh) {
      // Don't count if it was already inside again
      brokeAbove = true;
      breakoutExtreme = Math.max(breakoutExtreme, bar.h);
    } else if (bar.c < rangeLow && bar.o >= rangeLow) {
      brokeBelowVal = true;
      breakoutExtreme = Math.min(breakoutExtreme || Infinity, bar.l);
    }
  }

  // Current candle must close back inside the range
  const curInsideRange = cur.c >= rangeLow && cur.c <= rangeHigh;

  if (brokeAbove && curInsideRange) {
    patterns.push({
      name: '4H Range Reentry (Short)',
      direction: 'bearish',
      strength: 0.70,
      reliability: 0.68,
      category: 'four_hour_range',
      _breakoutExtreme: breakoutExtreme,
    });
  }

  if (brokeBelowVal && curInsideRange) {
    patterns.push({
      name: '4H Range Reentry (Long)',
      direction: 'bullish',
      strength: 0.70,
      reliability: 0.68,
      category: 'four_hour_range',
      _breakoutExtreme: breakoutExtreme,
    });
  }

  return patterns;
}

/* ── Liquidity Box ───────────────────────────────────────────── */

export function detectLiquidityBox(candles) {
  return null; // 4H Range uses its own range definition
}

/* ── Risk Scoring ────────────────────────────────────────────── */

export function computeRiskScore({ candles, patterns, box, opts }) {
  const cur = candles[candles.length - 1];
  const top = patterns?.[0];
  if (!top) return noTrade(cur, candles);

  // Volume gate
  const vol = avgVolume(candles, 10);
  if (vol < 5000) return noTrade(cur, candles);

  const direction = top.direction === 'bearish' ? 'short' : 'long';
  const entry = direction === 'long' ? cur.c * 1.0015 : cur.c * 0.9985;

  // SL: at breakout extreme
  const breakoutExtreme = top._breakoutExtreme || entry;
  const slDist = Math.max(Math.abs(entry - breakoutExtreme), entry * 0.005);

  // Target: 2× risk distance
  const targetDist = slDist * 2;

  const sl = direction === 'long' ? entry - slDist : entry + slDist;
  const target = direction === 'long' ? entry + targetDist : entry - targetDist;
  const rr = targetDist / Math.max(slDist, 1e-9);

  // Score
  const signalClarity = Math.min(25, top.strength * 25);
  const patternRel = top.reliability * 15;
  const rrScore = 20; // Fixed: 2:1 R:R is always good

  // Volume on reentry bar
  const curVol = cur.v || 0;
  const volConfirm = vol > 0 && curVol > vol * 1.2 ? 8 : vol > 0 && curVol > vol * 0.8 ? 4 : 0;

  const raw = signalClarity + rrScore + patternRel + volConfirm;
  const confidence = buildConfidence(raw);
  const action = confidenceToAction(confidence, direction);

  return {
    total: Math.round(raw), confidence,
    breakdown: { signalClarity: Math.round(signalClarity), lowNoise: 0, riskReward: rrScore, patternReliability: Math.round(patternRel), confluence: volConfirm },
    level: confidence >= 75 ? 'high' : confidence >= 60 ? 'moderate' : 'low',
    action, entry, sl, target, rr, direction,
    context: 'breakout',
    maxHoldBars: 15,
  };
}
