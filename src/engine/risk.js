/**
 * Risk / confidence score 0–100 + trade action hints.
 *
 * Raw score (0–100) from 5 weighted components is rescaled to a
 * confidence score (40–100) so the output rarely dips below 50.
 *
 * Action labels:
 *   STRONG BUY / STRONG SHORT  — confidence >= 72 + directional pattern
 *   BUY / SHORT                — confidence >= 58 + directional pattern
 *   WAIT                       — confidence >= 50 + any pattern
 *   NO TRADE                   — below 50 or no pattern
 */

/** Max points per component (sum = 100). */
export const RISK_SIGNAL_DEFINITIONS = [
  {
    key: 'signalClarity',
    label: 'Signal clarity',
    max: 25,
    meaning:
      'Measures how decisive the strongest detected candlestick pattern is. Pattern strength (0–1) × 25. Clear, strong setups score highest.',
  },
  {
    key: 'lowNoise',
    label: 'Low noise (trend quality)',
    max: 20,
    meaning:
      'Rewards cleaner directional movement vs chop. ATR compared to average candle body size; high chop lowers this component.',
  },
  {
    key: 'riskReward',
    label: 'Risk : reward',
    max: 25,
    meaning:
      'Scores the actual R:R using swing-based stop-loss (last 5 bars) and resistance/support target (last 15 bars). Higher R:R earns more points.',
  },
  {
    key: 'patternReliability',
    label: 'Pattern reliability',
    max: 15,
    meaning:
      'Uses the built-in reliability (0–1) of the top pattern × 15. More statistically reliable patterns add more points.',
  },
  {
    key: 'confluence',
    label: 'Confluence',
    max: 15,
    meaning:
      'Bonus stack: volume spike (+5), SMA alignment with direction (+5), context alignment (+4), liquidity-box signal (+5). Capped at 15.',
  },
];

/* ── helpers ─────────────────────────────────────────────────────── */

function sma(vals, n) {
  if (!vals.length || n < 1) return null;
  const slice = vals.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function atrLike(candles, n = 14) {
  if (candles.length < 2) return 0;
  let s = 0;
  const m = Math.min(n, candles.length - 1);
  for (let i = candles.length - m; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    s += tr;
  }
  return s / m;
}

/* ── context detection ───────────────────────────────────────────── */

/**
 * Where the current price sits relative to recent structure.
 * @returns {'at_support' | 'at_resistance' | 'mid_range' | 'breakout'}
 */
export function detectContext(candles, box) {
  if (!candles || candles.length < 5) return 'mid_range';

  const cur = candles[candles.length - 1];
  const window = candles.slice(-20);
  const hi20 = Math.max(...window.map((c) => c.h));
  const lo20 = Math.min(...window.map((c) => c.l));
  const range20 = hi20 - lo20 || 1;

  // Box breakout overrides
  if (box) {
    if (cur.c > box.high) return 'breakout';
    if (cur.c < box.low) return 'breakout';
  }

  const pct = (cur.c - lo20) / range20;
  if (pct <= 0.20) return 'at_support';
  if (pct >= 0.80) return 'at_resistance';
  return 'mid_range';
}

/* ── main score ──────────────────────────────────────────────────── */

/**
 * @param {object} params
 * @param {Array} params.candles
 * @param {Array} params.patterns
 * @param {object|null} params.box
 */
export function computeRiskScore({ candles, patterns, box }) {
  const top = patterns?.length ? patterns[0] : null;
  const cur = candles[candles.length - 1];

  /* ── 1. Signal clarity (max 25) ──────────────────────────────── */
  const signalClarity = top ? top.strength * 25 : 2;

  /* ── 2. Low noise / trend quality (max 20) ───────────────────── */
  const bodies = candles.slice(-6, -1).map((c) => Math.abs(c.c - c.o));
  const avgBody = bodies.reduce((a, b) => a + b, 0) / Math.max(bodies.length, 1) || 1;
  const atr = atrLike(candles, 10);
  const chop = Math.min(1, atr / (avgBody * 3));
  const lowNoise = (1 - chop) * 20;

  /* ── 3. Risk:Reward (max 25) — swing-based, not hardcoded ──── */
  const direction =
    top?.direction === 'bearish' ? 'short' : top?.direction === 'bullish' ? 'long' : 'long';

  // Swing-based SL from last 5 candle extremes
  const recentSlice = candles.slice(-5);
  const swingLow = Math.min(...recentSlice.map((c) => c.l));
  const swingHigh = Math.max(...recentSlice.map((c) => c.h));

  let slDist, targetDist, sl, target;
  const entry = cur.c;

  if (direction === 'long') {
    slDist = Math.max(entry - swingLow, entry * 0.003);
    sl = entry - slDist;
    // Target: resistance from wider window or minimum 2R
    const widerHighs = candles.slice(-15).map((c) => c.h);
    const resistance = Math.max(...widerHighs);
    targetDist = Math.max(resistance - entry, slDist * 2);
    target = entry + targetDist;
  } else {
    slDist = Math.max(swingHigh - entry, entry * 0.003);
    sl = entry + slDist;
    // Target: support from wider window or minimum 2R
    const widerLows = candles.slice(-15).map((c) => c.l);
    const support = Math.min(...widerLows);
    targetDist = Math.max(entry - support, slDist * 2);
    target = entry - targetDist;
  }

  const rr = targetDist / Math.max(slDist, 1e-9);
  // Clamp extreme R:R
  const rrClamped = Math.min(5, Math.max(0.3, rr));

  let rrScore = 5;
  if (rrClamped >= 2.5) rrScore = 25;
  else if (rrClamped >= 2) rrScore = 22;
  else if (rrClamped >= 1.5) rrScore = 18;
  else if (rrClamped >= 1) rrScore = 10;

  /* ── 4. Pattern reliability (max 15) ─────────────────────────── */
  const patternRel = top ? top.reliability * 15 : 3;

  /* ── 5. Confluence (max 15, bonus stack) ─────────────────────── */
  let confluence = 0;

  // Volume spike: current vs 10-bar average
  const vols = candles.slice(-11, -1).map((c) => c.v || 0);
  const avgV = vols.reduce((a, b) => a + b, 0) / Math.max(vols.length, 1);
  if (avgV > 0 && cur.v > avgV * 2) confluence += 5;
  else if (avgV > 0 && cur.v > avgV * 1.3) confluence += 3;

  // Volume trend: 3-bar increasing volume aligned with price direction
  if (candles.length >= 4) {
    const last3 = candles.slice(-3);
    const volUp = last3[0].v < last3[1].v && last3[1].v < last3[2].v;
    const priceUp = last3[2].c > last3[0].c;
    const priceDown = last3[2].c < last3[0].c;
    if (volUp && ((direction === 'long' && priceUp) || (direction === 'short' && priceDown))) {
      confluence += 3;
    }
    // Declining volume against pattern direction
    const volDown = last3[0].v > last3[1].v && last3[1].v > last3[2].v;
    if (volDown && ((direction === 'long' && priceDown) || (direction === 'short' && priceUp))) {
      confluence -= 2;
    }
  }

  // SMA alignment
  const closes = candles.map((c) => c.c);
  const s10 = sma(closes, 10);
  const s20 = sma(closes, 20);
  if (s10 != null && s20 != null) {
    if (top?.direction === 'bullish' && s10 > s20) confluence += 5;
    if (top?.direction === 'bearish' && s10 < s20) confluence += 5;
    if (top?.direction === 'neutral') confluence += 2;
  }

  // Context alignment
  const context = detectContext(candles, box);
  if (top?.direction === 'bullish' && context === 'at_support') confluence += 4;
  else if (top?.direction === 'bearish' && context === 'at_resistance') confluence += 4;
  else if (top?.direction === 'bullish' && context === 'at_resistance') confluence -= 3;
  else if (top?.direction === 'bearish' && context === 'at_support') confluence -= 3;
  else if (context === 'breakout') confluence += 3;

  // Box breakout / trap
  if (box && (box.breakout !== 'none' || box.trap !== 'none')) confluence += 5;

  confluence = Math.max(0, confluence);

  /* ── Raw → Confidence ────────────────────────────────────────── */
  const raw =
    signalClarity + lowNoise + rrScore + patternRel + Math.min(15, confluence);
  const rawClamped = Math.min(100, Math.round(raw));

  // Rescale: raw 0–100 → confidence 40–100
  const confidence = Math.round(40 + (rawClamped / 100) * 60);

  const breakdown = {
    signalClarity: Math.round(signalClarity),
    lowNoise: Math.round(lowNoise),
    riskReward: rrScore,
    patternReliability: Math.round(patternRel),
    confluence: Math.min(15, Math.round(Math.max(0, confluence))),
  };

  /* ── Risk level ──────────────────────────────────────────────── */
  let level = 'high';
  if (confidence >= 72) level = 'low';
  else if (confidence >= 55) level = 'moderate';

  /* ── Action ──────────────────────────────────────────────────── */
  let action = 'NO TRADE';
  if (confidence >= 72 && top && top.direction !== 'neutral') {
    action = top.direction === 'bearish' ? 'STRONG SHORT' : 'STRONG BUY';
  } else if (confidence >= 58 && top && top.direction !== 'neutral') {
    action = top.direction === 'bearish' ? 'SHORT' : 'BUY';
  } else if (confidence >= 50 && top) {
    action = 'WAIT';
  }

  return {
    total: rawClamped,
    confidence,
    breakdown,
    level,
    action,
    entry,
    sl,
    target,
    rr: rrClamped,
    direction,
    context,
  };
}
