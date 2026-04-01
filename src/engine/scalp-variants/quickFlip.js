/**
 * Quick Flip scalp variant.
 *
 * PURE RULE-BASED — no confidence scoring. All 3 conditions met = trade.
 *
 * Rules (from transcript):
 * 1. Box the 15-min opening range (ORB high/low)
 * 2. Confirm it's a "liquidity candle" (range ≥ 25% of 14-day ATR)
 * 3. Wait for reversal candlestick (hammer or engulfing) OUTSIDE the range:
 *    - Green/bullish ORB → look for bearish reversal ABOVE range → SHORT
 *    - Red/bearish ORB → look for bullish reversal BELOW range → LONG
 * 4. Entry: at reversal candle break
 * 5. Target: opposite end of ORB range
 * 6. SL: beyond reversal candle extreme
 * 7. Only within first 90 minutes of market open
 *
 * "Most of the time the [liquidity] candle is reversed."
 *
 * === HARD CONSTRAINTS ===
 * - maxHoldBars: 15 (scalp limit)
 */

/* ── Helpers (self-contained, no shared imports) ─────────────── */

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

function _isHammer(candles) {
  if (candles.length < 2) return null;
  const c = candles[candles.length - 1];
  const body = Math.abs(c.c - c.o);
  const range = c.h - c.l;
  if (range < 1e-9 || body < 1e-9) return null;
  const upperWick = c.h - Math.max(c.o, c.c);
  const lowerWick = Math.min(c.o, c.c) - c.l;

  // Bullish hammer: long lower wick, small upper
  if (lowerWick >= body * 2 && upperWick < body * 1.0)
    return { type: 'hammer', direction: 'bullish' };
  // Bearish inverted hammer: long upper wick, small lower
  if (upperWick >= body * 2 && lowerWick < body * 1.0)
    return { type: 'inverted_hammer', direction: 'bearish' };
  return null;
}

function _isEngulfing(candles) {
  if (candles.length < 2) return null;
  const prev = candles[candles.length - 2];
  const cur = candles[candles.length - 1];
  const prevBody = Math.abs(prev.c - prev.o);
  const curBody = Math.abs(cur.c - cur.o);
  if (prevBody < 1e-9 || curBody < prevBody) return null;

  // Bullish engulfing
  if (prev.c < prev.o && cur.c > cur.o && cur.o <= prev.c && cur.c >= prev.o)
    return { type: 'bullish_engulfing', direction: 'bullish' };
  // Bearish engulfing
  if (prev.c > prev.o && cur.c < cur.o && cur.o >= prev.c && cur.c <= prev.o)
    return { type: 'bearish_engulfing', direction: 'bearish' };
  return null;
}

/* ── Pattern Detection ───────────────────────────────────────── */

export function detectPatterns(candles, opts = {}) {
  if (!candles || candles.length < 10) return [];
  const cur = candles[candles.length - 1];
  const barIndex = opts?.barIndex ?? 0;
  const orbHigh = opts?.orbHigh;
  const orbLow = opts?.orbLow;
  if (!orbHigh || !orbLow || orbHigh <= orbLow) return [];

  // Step 1: ORB range
  const orbRange = orbHigh - orbLow;

  // Step 2: Liquidity candle check (≥ 25% of 14-day ATR)
  const atr14 = _atr(candles);
  if (atr14 <= 0 || orbRange < atr14 * 0.25) return [];

  // Only within first 90 bars (90 minutes on 1m)
  if (barIndex > 90) return [];

  // Determine ORB direction from the opening bar
  // Use the candle at window start (barIndex 0) or infer from ORB position
  const orbMid = (orbHigh + orbLow) / 2;
  // If most of the range is above the midpoint of the first few bars, it's bullish
  // Simplified: use first available day candle open vs ORB midpoint
  const firstCandle = candles.length > 20 ? candles[candles.length - barIndex - 1] : null;
  const orbBullish = firstCandle ? firstCandle.c > firstCandle.o : cur.c > orbMid;

  // Step 3: Look for reversal candlestick OUTSIDE the range
  const hammer = _isHammer(candles);
  const engulfing = _isEngulfing(candles);
  const reversal = hammer || engulfing;
  if (!reversal) return [];

  if (orbBullish && cur.c > orbHigh && reversal.direction === 'bearish') {
    // Green ORB + price above range + bearish reversal → SHORT
    return [{
      name: `Quick Flip Short (${reversal.type})`,
      direction: 'bearish',
      strength: 0.80,
      reliability: 0.72,
      category: 'quick_flip',
    }];
  }

  if (!orbBullish && cur.c < orbLow && reversal.direction === 'bullish') {
    // Red ORB + price below range + bullish reversal → LONG
    return [{
      name: `Quick Flip Long (${reversal.type})`,
      direction: 'bullish',
      strength: 0.80,
      reliability: 0.72,
      category: 'quick_flip',
    }];
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
  const entry = direction === 'long' ? cur.c * 1.001 : cur.c * 0.999;

  // Target: opposite end of ORB range (from transcript)
  const targetDist = direction === 'long'
    ? Math.max(orbHigh - entry, entry * 0.002)
    : Math.max(entry - orbLow, entry * 0.002);
  const target = direction === 'long' ? entry + targetDist : entry - targetDist;

  // SL: beyond the reversal candle extreme (from transcript)
  const recentHigh = Math.max(...candles.slice(-3).map(c => c.h));
  const recentLow = Math.min(...candles.slice(-3).map(c => c.l));
  const slDist = direction === 'long'
    ? Math.max(entry - recentLow, entry * 0.005)
    : Math.max(recentHigh - entry, entry * 0.005);
  const sl = direction === 'long' ? entry - slDist : entry + slDist;

  // All 3 conditions met → trade is ON
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
