/**
 * Box Theory scalp variant.
 *
 * Strategy: Use previous day's high/low as a "box".
 * - Sell at/near box top (strongest seller zone)
 * - Buy at/near box bottom (strongest buyer zone)
 * - Skip the middle (noise / indecision)
 *
 * Source: "Box Theory" — fade the extremes of the previous day's range.
 *
 * === HARD CONSTRAINTS ===
 * - maxHoldBars: 15 (scalp limit)
 * - Timeframe: 1m
 */

import { atrLike, avgVolume, noTrade, buildConfidence, confidenceToAction } from './shared.js';

const EDGE_ZONE = 0.15; // top/bottom 15% of box = trade zone
const DEAD_ZONE = 0.35; // middle 35% each side of center = no trade

/* ── Pattern Detection ───────────────────────────────────────── */

export function detectPatterns(candles, opts = {}) {
  if (!candles || candles.length < 5) return [];
  const cur = candles[candles.length - 1];
  const prevHigh = opts?.prevDayHigh;
  const prevLow = opts?.prevDayLow;
  if (!prevHigh || !prevLow || prevHigh <= prevLow) return [];

  const range = prevHigh - prevLow;
  const midline = prevLow + range * 0.5;
  const topZone = prevHigh - range * EDGE_ZONE;
  const bottomZone = prevLow + range * EDGE_ZONE;

  const patterns = [];

  // Near top of box → bearish (sell zone)
  if (cur.c >= topZone) {
    const proximity = Math.min(1, (cur.c - topZone) / (range * EDGE_ZONE));
    patterns.push({
      name: 'Box Top Fade',
      direction: 'bearish',
      strength: 0.6 + proximity * 0.35,
      reliability: 0.72,
      category: 'box_theory',
    });
  }

  // Near bottom of box → bullish (buy zone)
  if (cur.c <= bottomZone) {
    const proximity = Math.min(1, (bottomZone - cur.c) / (range * EDGE_ZONE));
    patterns.push({
      name: 'Box Bottom Bounce',
      direction: 'bullish',
      strength: 0.6 + proximity * 0.35,
      reliability: 0.72,
      category: 'box_theory',
    });
  }

  // Above box → extended, potential reversal short
  if (cur.c > prevHigh) {
    const ext = Math.min(1, (cur.c - prevHigh) / (range * 0.2));
    patterns.push({
      name: 'Box Breakout Fade (Top)',
      direction: 'bearish',
      strength: 0.7 + ext * 0.25,
      reliability: 0.65,
      category: 'box_theory',
    });
  }

  // Below box → extended, potential reversal long
  if (cur.c < prevLow) {
    const ext = Math.min(1, (prevLow - cur.c) / (range * 0.2));
    patterns.push({
      name: 'Box Breakout Fade (Bottom)',
      direction: 'bullish',
      strength: 0.7 + ext * 0.25,
      reliability: 0.65,
      category: 'box_theory',
    });
  }

  return patterns;
}

/* ── Liquidity Box (reuse prev day range as the box) ─────────── */

export function detectLiquidityBox(candles) {
  // Box Theory doesn't use micro-consolidation boxes
  return null;
}

/* ── Risk Scoring ────────────────────────────────────────────── */

export function computeRiskScore({ candles, patterns, box, opts }) {
  const cur = candles[candles.length - 1];
  const top = patterns?.[0];
  if (!top) return noTrade(cur, candles);

  const prevHigh = opts?.prevDayHigh;
  const prevLow = opts?.prevDayLow;
  if (!prevHigh || !prevLow) return noTrade(cur, candles);

  // Volume gate
  const vol = avgVolume(candles, 10);
  if (vol < 5000) return noTrade(cur, candles);

  // In dead zone (middle) → no trade
  const range = prevHigh - prevLow;
  const midline = prevLow + range * 0.5;
  const deadTop = midline + range * DEAD_ZONE;
  const deadBottom = midline - range * DEAD_ZONE;
  if (cur.c > deadBottom && cur.c < deadTop && cur.c > prevLow + range * EDGE_ZONE && cur.c < prevHigh - range * EDGE_ZONE) {
    return noTrade(cur, candles);
  }

  const direction = top.direction === 'bearish' ? 'short' : 'long';
  const atrVal = atrLike(candles, 14);
  const entry = direction === 'long' ? cur.c * 1.0015 : cur.c * 0.9985;

  // SL: beyond box edge (wide safety net)
  const slDist = Math.max(atrVal * 3.0, entry * 0.020);

  // Target: midline of box (center)
  const targetDist = direction === 'long'
    ? Math.max(midline - entry, entry * 0.003)
    : Math.max(entry - midline, entry * 0.003);

  const sl = direction === 'long' ? entry - slDist : entry + slDist;
  const target = direction === 'long' ? entry + targetDist : entry - targetDist;

  // Score
  const signalClarity = Math.min(25, top.strength * 25);
  const patternRel = top.reliability * 15;

  // Volume confirmation
  const curVol = cur.v || 0;
  const volBonus = vol > 0 && curVol > vol * 1.3 ? 10 : vol > 0 && curVol > vol * 0.8 ? 5 : 0;

  // Proximity to edge (closer = better)
  const edgeDist = direction === 'long'
    ? Math.max(0, prevLow + range * EDGE_ZONE - cur.c) / (range * EDGE_ZONE)
    : Math.max(0, cur.c - (prevHigh - range * EDGE_ZONE)) / (range * EDGE_ZONE);
  const proximityScore = Math.min(20, edgeDist * 20 + 10);

  const raw = signalClarity + proximityScore + patternRel + volBonus;
  const confidence = buildConfidence(raw);
  const action = confidenceToAction(confidence, direction);

  return {
    total: Math.round(raw), confidence,
    breakdown: { signalClarity: Math.round(signalClarity), lowNoise: Math.round(proximityScore), riskReward: 20, patternReliability: Math.round(patternRel), confluence: volBonus },
    level: confidence >= 75 ? 'high' : confidence >= 60 ? 'moderate' : 'low',
    action, entry, sl, target,
    rr: targetDist / Math.max(slDist, 1e-9),
    direction, context: direction === 'long' ? 'at_support' : 'at_resistance',
    maxHoldBars: 15,
  };
}
