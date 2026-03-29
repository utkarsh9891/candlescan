/**
 * Pattern detection engine v2.
 * Fixes from adversarial review:
 *  - avgBody denominator bug fixed (uses actual slice length)
 *  - Volume confirmation on engulfing/piercing/morning star
 *  - Wider trend lookback (8 candles instead of 4-5)
 *  - Tighter doji threshold (0.05 instead of 0.10)
 *  - Time-of-day awareness (suppress momentum in first 3 bars)
 *  - Liquidity sweep lookback widened to 8 bars
 */

/** @typedef {{ o:number,h:number,l:number,c:number,v:number,t?:number }} Candle */

function body(c) { return Math.abs(c.c - c.o); }
function range(c) { return c.h - c.l; }
function upperWick(c) { return c.h - Math.max(c.o, c.c); }
function lowerWick(c) { return Math.min(c.o, c.c) - c.l; }
function isBull(c) { return c.c >= c.o; }
function midBody(c) { return (Math.max(c.o, c.c) + Math.min(c.o, c.c)) / 2; }

function priorTrend(candles, idx, lookback, dir) {
  let up = 0, down = 0;
  const start = Math.max(0, idx - lookback);
  for (let i = start; i < idx; i++) {
    if (isBull(candles[i])) up++; else down++;
  }
  if (dir === 'down') return down >= up;
  if (dir === 'up') return up >= down;
  return true;
}

/** Volume confirmation factor: min(2, cur.v / avgVol). Returns 1 if no volume data. */
function volFactor(candles, n) {
  const vols = candles.slice(Math.max(0, n - 11), n - 1).map(c => c.v || 0);
  if (!vols.length) return 1;
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
  if (avg <= 0) return 1;
  return Math.min(2, (candles[n - 1].v || 0) / avg);
}

/**
 * @param {Candle[]} candles
 * @param {{ barIndex?: number }} [opts] — barIndex = position in session (0-based). Used to suppress early-session momentum.
 */
export function detectPatterns(candles, opts) {
  if (!candles?.length || candles.length < 5) return [];

  const n = candles.length;
  const cur = candles[n - 1];
  const prev = candles[n - 2];
  const patterns = [];
  const barIndex = opts?.barIndex ?? n; // default: assume mid-session

  // FIX: use actual slice length as denominator (was min(5, n-1) — bug)
  const bodySlice = candles.slice(-6, -1);
  const avgBody5 = bodySlice.length > 0
    ? bodySlice.reduce((s, c) => s + body(c), 0) / bodySlice.length
    : 1;

  const vf = volFactor(candles, n);

  /* --- Engulfing (lookback widened to 8) --- */
  if (prev && n >= 3) {
    const pb = body(prev);
    const cb = body(cur);
    if (!isBull(prev) && isBull(cur) && cur.o <= prev.c && cur.c >= prev.o && cb >= pb * 0.95) {
      const ctx = priorTrend(candles, n - 1, 8, 'down');
      const baseStr = ctx ? 0.72 + Math.min(0.2, cb / (pb + 1e-9) * 0.05) : 0.55;
      patterns.push({
        name: 'Bullish Engulfing', direction: 'bullish',
        strength: Math.min(1, baseStr * Math.min(1.5, vf)), // volume-weighted, capped
        category: 'engulfing', emoji: '🟢',
        tip: 'Green engulfs red → buy bias',
        description: 'Current bullish body fully covers prior bearish body; stronger after a short downtrend.',
        reliability: 0.62, candleIndices: [n - 2, n - 1],
      });
    }
    if (isBull(prev) && !isBull(cur) && cur.o >= prev.c && cur.c <= prev.o && cb >= pb * 0.95) {
      const ctx = priorTrend(candles, n - 1, 8, 'up');
      const baseStr = ctx ? 0.7 : 0.52;
      patterns.push({
        name: 'Bearish Engulfing', direction: 'bearish',
        strength: Math.min(1, baseStr * Math.min(1.5, vf)),
        category: 'engulfing', emoji: '🔴',
        tip: 'Red engulfs green → sell bias',
        description: 'Bearish body fully covers prior bullish body; stronger after uptrend.',
        reliability: 0.6, candleIndices: [n - 2, n - 1],
      });
    }
  }

  /* --- Piercing Pattern (volume-weighted) --- */
  if (prev && n >= 3) {
    const pb = body(prev);
    const cb = body(cur);
    if (!isBull(prev) && isBull(cur) && cur.o < prev.l && cur.c > midBody(prev) && cur.c < prev.o && cb > 0 && pb > 0) {
      const ctx = priorTrend(candles, n - 1, 8, 'down');
      patterns.push({
        name: 'Piercing Pattern', direction: 'bullish',
        strength: Math.min(1, (ctx ? 0.68 : 0.50) * Math.min(1.5, vf)),
        category: 'piercing', emoji: '🔷',
        tip: 'Opens below prior low, closes above prior midpoint',
        description: 'Bullish 2-candle reversal: gap-down open then strong recovery past prior body midpoint.',
        reliability: 0.60, candleIndices: [n - 2, n - 1],
      });
    }
  }

  /* --- Hammer family (lookback widened to 8) --- */
  const r = range(cur);
  const b = body(cur);
  const uw = upperWick(cur);
  const lw = lowerWick(cur);
  if (r > 1e-9) {
    const smallBody = b < r * 0.35;
    const longLow = lw >= Math.max(b * 2, r * 0.45);
    const tinyUp = uw < r * 0.15;
    const longUp = uw >= Math.max(b * 2, r * 0.45);
    const tinyLow = lw < r * 0.15;

    if (smallBody && longLow && tinyUp && priorTrend(candles, n - 1, 8, 'down')) {
      patterns.push({ name: 'Hammer', direction: 'bullish', strength: 0.65, category: 'hammer', emoji: '🔨', tip: 'Long lower wick after dip → bounce idea', description: 'Long lower shadow, small body at top of range — classic bullish rejection.', reliability: 0.58, candleIndices: [n - 1] });
    }
    if (smallBody && longUp && tinyLow && priorTrend(candles, n - 1, 8, 'down')) {
      patterns.push({ name: 'Inverted Hammer', direction: 'bullish', strength: 0.48, category: 'hammer', emoji: '⬆️', tip: 'Weak bullish reversal hint', description: 'Upper wick after decline — buyers tried; needs confirmation.', reliability: 0.45, candleIndices: [n - 1] });
    }
    if (smallBody && longUp && tinyLow && priorTrend(candles, n - 1, 8, 'up')) {
      patterns.push({ name: 'Shooting Star', direction: 'bearish', strength: 0.66, category: 'hammer', emoji: '⭐', tip: 'Rejection at highs', description: 'Long upper wick after rally — potential exhaustion.', reliability: 0.57, candleIndices: [n - 1] });
    }
    if (smallBody && longLow && tinyUp && priorTrend(candles, n - 1, 8, 'up')) {
      patterns.push({ name: 'Hanging Man', direction: 'bearish', strength: 0.5, category: 'hammer', emoji: '🪢', tip: 'Caution at top', description: 'Hammer-like after uptrend — weaker bearish warning.', reliability: 0.48, candleIndices: [n - 1] });
    }
  }

  /* --- Morning / Evening star (volume-weighted, lookback 8) --- */
  if (n >= 3) {
    const c0 = candles[n - 3], c1 = candles[n - 2], c2 = candles[n - 1];
    const b0 = body(c0), b1 = body(c1), b2 = body(c2), r1 = range(c1);
    if (!isBull(c0) && b0 > avgBody5 * 1.1 && b1 < r1 * 0.35 && isBull(c2) && b2 > avgBody5 && c2.c > midBody(c0)) {
      patterns.push({ name: 'Morning Star', direction: 'bullish', strength: Math.min(1, 0.75 * Math.min(1.5, vf)), category: 'reversal', emoji: '🌅', tip: 'Three-candle bullish reversal', description: 'Big red, small star, strong green closing past midpoint of first candle.', reliability: 0.64, candleIndices: [n - 3, n - 2, n - 1] });
    }
    if (isBull(c0) && b0 > avgBody5 * 1.1 && b1 < r1 * 0.35 && !isBull(c2) && b2 > avgBody5 && c2.c < midBody(c0)) {
      patterns.push({ name: 'Evening Star', direction: 'bearish', strength: Math.min(1, 0.74 * Math.min(1.5, vf)), category: 'reversal', emoji: '🌆', tip: 'Three-candle bearish reversal', description: 'Big green, small body, strong red closing below midpoint of first.', reliability: 0.63, candleIndices: [n - 3, n - 2, n - 1] });
    }
  }

  /* --- First pullback continuation --- */
  if (n >= 8) {
    const slice = candles.slice(-8, -1);
    let bullRun = 0;
    for (const c of slice.slice(0, 5)) { if (isBull(c)) bullRun++; }
    const counter = slice.slice(5, 7);
    const resume = candles[n - 1];
    if (bullRun >= 4 && counter.every(c => !isBull(c)) && isBull(resume) && body(resume) > avgBody5 * 1.2) {
      patterns.push({ name: 'First Pullback (Bull)', direction: 'bullish', strength: 0.58, category: 'pullback', emoji: '📈', tip: 'Trend resume after shallow dip', description: 'Strong up-leg, 1–2 red candles, strong green continuation.', reliability: 0.55, candleIndices: [n - 3, n - 2, n - 1] });
    }
    let bearRun = 0;
    for (const c of slice.slice(0, 5)) { if (!isBull(c)) bearRun++; }
    if (bearRun >= 4 && counter.every(c => isBull(c)) && !isBull(resume) && body(resume) > avgBody5 * 1.2) {
      patterns.push({ name: 'First Pullback (Bear)', direction: 'bearish', strength: 0.57, category: 'pullback', emoji: '📉', tip: 'Trend resume after bounce', description: 'Strong down-leg, small bounce, strong red continuation.', reliability: 0.54, candleIndices: [n - 3, n - 2, n - 1] });
    }
  }

  /* --- Liquidity sweeps (lookback widened to 8) --- */
  if (n >= 9) {
    const recentLow = Math.min(...candles.slice(-9, -1).map(c => c.l));
    const recentHigh = Math.max(...candles.slice(-9, -1).map(c => c.h));
    if (cur.l < recentLow && cur.c > recentLow && lowerWick(cur) > body(cur) * 1.5) {
      // Reduced strength (0.50 from 0.70) — high false positive rate on NSE
      patterns.push({ name: 'Liquidity Sweep Bullish', direction: 'bullish', strength: 0.50, category: 'liquidity', emoji: '💧', tip: 'Stops run under lows, close reclaimed', description: 'Wick below recent lows then close back above — stop-hunt reversal up.', reliability: 0.45, candleIndices: [n - 1] });
    }
    if (cur.h > recentHigh && cur.c < recentHigh && upperWick(cur) > body(cur) * 1.5) {
      // Reduced strength (0.48 from 0.69) — high false positive rate on NSE
      patterns.push({ name: 'Liquidity Sweep Bearish', direction: 'bearish', strength: 0.48, category: 'liquidity', emoji: '💧', tip: 'Stops above highs, failed breakout', description: 'Wick above recent highs then close back inside range.', reliability: 0.44, candleIndices: [n - 1] });
    }
  }

  /* --- Indecision: Doji (tighter: 0.05) and Spinning Top --- */
  let hasDoji = false;
  if (r > 1e-9) {
    if (b < r * 0.05 && uw > r * 0.25 && lw > r * 0.25) {
      hasDoji = true;
      patterns.push({ name: 'Doji', direction: 'neutral', strength: 0.45, category: 'indecision', emoji: '➕', tip: 'Perfect indecision — open ≈ close', description: 'Extremely small body with wicks on both sides. Market is undecided.', reliability: 0.42, candleIndices: [n - 1] });
    }
    if (!hasDoji && b < r * 0.30 && b >= r * 0.05 && uw > b && lw > b) {
      patterns.push({ name: 'Spinning Top', direction: 'neutral', strength: 0.40, category: 'indecision', emoji: '🔄', tip: 'Weak indecision — small body, long wicks', description: 'Small body with notable wicks. Mild indecision.', reliability: 0.38, candleIndices: [n - 1] });
    }
    if (!hasDoji && b < r * 0.25 && uw > r * 0.35 && lw > r * 0.35) {
      patterns.push({ name: 'Manipulation Candle', direction: 'neutral', strength: 0.55, category: 'liquidity', emoji: '⚠️', tip: 'Choppy indecision — wait', description: 'Tiny body, long wicks both sides — liquidity grab / fake-out risk.', reliability: 0.4, candleIndices: [n - 1] });
    }
  }

  /* --- Momentum (suppress in first 3 bars of session) --- */
  if (avgBody5 > 1e-9 && b >= avgBody5 * 2.2 && barIndex >= 3) {
    let terminationRisk = 'low';
    if (n >= 2) {
      const prevCandle = candles[n - 2];
      const momDirection = isBull(cur) ? 'bullish' : 'bearish';
      if (momDirection === 'bullish' && uw > b * 0.5) terminationRisk = 'medium';
      if (momDirection === 'bearish' && lw > b * 0.5) terminationRisk = 'medium';
      if (momDirection === 'bullish' && uw > b * 0.8) terminationRisk = 'high';
      if (momDirection === 'bearish' && lw > b * 0.8) terminationRisk = 'high';
      if (prevCandle.v > 0 && cur.v < prevCandle.v * 0.7) {
        terminationRisk = terminationRisk === 'low' ? 'medium' : 'high';
      }
    }
    patterns.push({
      name: 'Momentum Candle', direction: isBull(cur) ? 'bullish' : 'bearish',
      strength: Math.min(0.85, 0.5 + (b / (avgBody5 * 4)) * 0.35),
      category: 'momentum', emoji: isBull(cur) ? '🚀' : '⬇️',
      tip: terminationRisk === 'high' ? 'Strong push but showing exhaustion signs' : terminationRisk === 'medium' ? 'Strong push with some caution signals' : 'Unusually large body — strong push',
      description: `Body much larger than recent average — directional impulse. Termination risk: ${terminationRisk}.`,
      reliability: 0.52, terminationRisk, candleIndices: [n - 1],
    });
  }

  patterns.sort((a, b) => b.strength - a.strength);
  return patterns;
}
