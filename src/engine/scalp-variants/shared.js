/**
 * Shared utilities for scalp variant sub-engines.
 * All variants reuse these helpers for ATR, candle patterns, ranges, etc.
 */

/* ── ATR ─────────────────────────────────────────────────────── */

export function atrLike(candles, n = 14) {
  if (candles.length < 2) return 0;
  let s = 0;
  const m = Math.min(n, candles.length - 1);
  for (let i = candles.length - m; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    s += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  }
  return s / m;
}

/* ── EMA ─────────────────────────────────────────────────────── */

export function emaVal(candles, period) {
  if (candles.length < period) return null;
  const k = 2 / (period + 1);
  let val = candles[0].c;
  for (let i = 1; i < candles.length; i++) {
    val = candles[i].c * k + val * (1 - k);
  }
  return val;
}

/* ── VWAP proxy ──────────────────────────────────────────────── */

export function vwapProxy(candles, n = 20) {
  const slice = candles.slice(-n);
  let sumPV = 0, sumV = 0;
  for (const c of slice) {
    const tp = (c.h + c.l + c.c) / 3;
    sumPV += tp * (c.v || 1);
    sumV += (c.v || 1);
  }
  return sumV > 0 ? sumPV / sumV : null;
}

/* ── Liquidity candle check (≥ 25% of ATR14) ────────────────── */

export function isLiquidityCandle(orbRange, atr14) {
  if (!atr14 || atr14 <= 0) return false;
  return orbRange >= atr14 * 0.25;
}

/* ── Fibonacci levels ────────────────────────────────────────── */

export function fibLevels(high, low) {
  const range = high - low;
  return {
    high,
    low,
    range,
    fib236: low + range * 0.236,
    fib382: low + range * 0.382,
    fib500: low + range * 0.500,
    fib618: low + range * 0.618,
    fib786: low + range * 0.786,
  };
}

/* ── Reversal candlestick detection ──────────────────────────── */

/**
 * Detect hammer / inverted hammer at the end of candles array.
 * @returns {{ type: 'hammer'|'inverted_hammer'|null, direction: 'bullish'|'bearish', strength: number }}
 */
export function detectHammer(candles) {
  if (candles.length < 3) return null;
  const c = candles[candles.length - 1];
  const body = Math.abs(c.c - c.o);
  const range = c.h - c.l;
  if (range < 1e-9) return null;

  const upperWick = c.h - Math.max(c.o, c.c);
  const lowerWick = Math.min(c.o, c.c) - c.l;

  // Hammer: long lower wick (≥ 2× body), small upper wick
  if (lowerWick >= body * 2 && upperWick < body * 1.0) {
    return { type: 'hammer', direction: 'bullish', strength: Math.min(1, lowerWick / range) };
  }

  // Inverted hammer: long upper wick (≥ 2× body), small lower wick
  if (upperWick >= body * 2 && lowerWick < body * 1.0) {
    return { type: 'inverted_hammer', direction: 'bearish', strength: Math.min(1, upperWick / range) };
  }

  return null;
}

/**
 * Detect bullish/bearish engulfing at the end of candles array.
 * @returns {{ type: 'bullish_engulfing'|'bearish_engulfing', direction: 'bullish'|'bearish', strength: number }}
 */
export function detectEngulfing(candles) {
  if (candles.length < 2) return null;
  const prev = candles[candles.length - 2];
  const cur = candles[candles.length - 1];

  const prevBody = Math.abs(prev.c - prev.o);
  const curBody = Math.abs(cur.c - cur.o);
  if (prevBody < 1e-9 || curBody < prevBody) return null;

  // Bullish engulfing: prev red, cur green, cur body engulfs prev body
  if (prev.c < prev.o && cur.c > cur.o && cur.o <= prev.c && cur.c >= prev.o) {
    return { type: 'bullish_engulfing', direction: 'bullish', strength: Math.min(1, curBody / (prevBody * 2)) };
  }

  // Bearish engulfing: prev green, cur red, cur body engulfs prev body
  if (prev.c > prev.o && cur.c < cur.o && cur.o >= prev.c && cur.c <= prev.o) {
    return { type: 'bearish_engulfing', direction: 'bearish', strength: Math.min(1, curBody / (prevBody * 2)) };
  }

  return null;
}

/* ── Volume helpers ──────────────────────────────────────────── */

export function avgVolume(candles, n = 10) {
  const slice = candles.slice(-(n + 1), -1); // exclude last candle (may be 0 vol)
  if (!slice.length) return 0;
  return slice.reduce((s, c) => s + (c.v || 0), 0) / slice.length;
}

/* ── No-trade template ───────────────────────────────────────── */

export function noTrade(cur, candles) {
  return {
    total: 0, confidence: 20,
    breakdown: { signalClarity: 0, lowNoise: 0, riskReward: 0, patternReliability: 0, confluence: 0 },
    level: 'low', action: 'NO TRADE',
    entry: cur.c, sl: cur.c, target: cur.c, rr: 0, direction: 'long',
    context: 'mid_range', maxHoldBars: 15,
  };
}

/* ── Time helpers ────────────────────────────────────────────── */

const IST_OFFSET = 19800;

export function istTimeStr(unixSec) {
  const d = new Date((unixSec + IST_OFFSET) * 1000);
  return d.toISOString().slice(11, 16);
}

/**
 * Compute the 4-hour range from day candles (first 240 bars on 1m).
 * @returns {{ high, low, range, direction: 'bullish'|'bearish' }} | null
 */
export function compute4HRange(dayCandles) {
  if (!dayCandles || dayCandles.length < 30) return null;
  // First 240 bars on 1m = 4 hours. If fewer bars available, use what we have up to 240.
  const slice = dayCandles.slice(0, Math.min(240, dayCandles.length));
  const high = Math.max(...slice.map(c => c.h));
  const low = Math.min(...slice.map(c => c.l));
  const first = slice[0];
  const last = slice[slice.length - 1];
  const direction = last.c >= first.o ? 'bullish' : 'bearish';
  return { high, low, range: high - low, direction };
}

/* ── Confidence builder ──────────────────────────────────────── */

/**
 * Build a confidence score from raw component scores.
 * Floor 20, ceiling 100. Same mapping as momentum scalp.
 */
export function buildConfidence(raw100) {
  const clamped = Math.min(100, Math.max(0, Math.round(raw100)));
  return Math.max(20, Math.min(100, Math.round(20 + (clamped / 100) * 80)));
}

/**
 * Map confidence to action label.
 */
export function confidenceToAction(confidence, direction) {
  if (confidence >= 75) return direction === 'short' ? 'STRONG SHORT' : 'STRONG BUY';
  if (confidence >= 65) return direction === 'short' ? 'SHORT' : 'BUY';
  if (confidence >= 50) return 'WAIT';
  return 'NO TRADE';
}
