/**
 * Scalping pattern detection engine.
 * Optimized for 1m candles, 5-10 min hold times, 9:30-11:00 AM window.
 *
 * Patterns (7 scalp-specific):
 *  1. VWAP Breakout/Rejection — institutional anchor cross
 *  2. Micro Momentum Burst — 2-3 consecutive directional candles + volume
 *  3. Opening Range Breakout (ORB) — first 10-15 bar range break
 *  4. EMA Crossover (5/13) — short-term trend change
 *  5. Volume Climax Reversal — exhaustion bar + reversal
 *  6. Previous Day High/Low Breakout — key institutional levels
 *  7. Micro Double Bottom/Top — support/resistance confirmation
 *
 * All patterns require volume factor >= 1.3× (no signal without volume).
 */

function body(c) { return Math.abs(c.c - c.o); }
function range(c) { return c.h - c.l; }
function isBull(c) { return c.c >= c.o; }

function rsi(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const change = candles[i].c - candles[i - 1].c;
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function ema(candles, period, field = 'c') {
  if (candles.length < period) return null;
  const k = 2 / (period + 1);
  let val = candles[0][field];
  for (let i = 1; i < candles.length; i++) {
    val = candles[i][field] * k + val * (1 - k);
  }
  return val;
}

function vwapProxy(candles, n = 20) {
  const slice = candles.slice(-n);
  let sumPV = 0, sumV = 0;
  for (const c of slice) {
    const tp = (c.h + c.l + c.c) / 3;
    sumPV += tp * (c.v || 1);
    sumV += (c.v || 1);
  }
  return sumV > 0 ? sumPV / sumV : null;
}

function volFactor(candles, n) {
  const vols = candles.slice(Math.max(0, n - 11), n - 1).map(c => c.v || 0);
  if (!vols.length) return 1;
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
  if (avg <= 0) return 1;
  // Use max of current vol and recent 3-bar avg (Yahoo 1m last candle often has 0 volume)
  const recent3 = candles.slice(Math.max(0, n - 4), n - 1).map(c => c.v || 0);
  const recent3avg = recent3.length ? recent3.reduce((a, b) => a + b, 0) / recent3.length : 0;
  const effectiveVol = Math.max(candles[n - 1].v || 0, recent3avg);
  return Math.min(3, effectiveVol / avg);
}

function avgBody(candles, lookback = 10) {
  const slice = candles.slice(-lookback - 1, -1);
  if (!slice.length) return 1;
  return slice.reduce((s, c) => s + body(c), 0) / slice.length || 1;
}

/**
 * @param {Array} candles — full candle array (prior days + current day bars seen so far)
 * @param {{ barIndex?: number, prevDayHigh?: number, prevDayLow?: number, orbHigh?: number, orbLow?: number }} [opts]
 */
export function detectPatterns(candles, opts) {
  if (!candles?.length || candles.length < 15) return [];

  const n = candles.length;
  const cur = candles[n - 1];
  const prev = candles[n - 2];
  const patterns = [];
  const vf = volFactor(candles, n);

  // Require 2.7× average volume
  if (vf < 2.7) return [];

  const ab = avgBody(candles, 10);
  const vwap = vwapProxy(candles, 20);

  // --- 1. VWAP Breakout/Rejection ---
  if (vwap && prev) {
    const prevSide = prev.c > vwap ? 'above' : 'below';
    const curSide = cur.c > vwap ? 'above' : 'below';

    // Bullish VWAP breakout: require strong body + prev bar confirmation
    if (prevSide === 'below' && curSide === 'above' && cur.c > cur.o
        && body(cur) > ab * 2.0 && prev.c > prev.o) {
      patterns.push({
        name: 'VWAP Breakout', direction: 'bullish',
        strength: Math.min(0.95, 0.65 * Math.min(2, vf)),
        category: 'vwap', emoji: '📊',
        tip: 'Price crossed above VWAP with volume — institutional buying',
        description: 'Price reclaimed VWAP from below with volume confirmation. Strong bullish signal.',
        reliability: 0.72, candleIndices: [n - 1],
      });
    }
    // Bearish VWAP breakdown: require strong body + prev bar confirmation
    if (prevSide === 'above' && curSide === 'below' && cur.c < cur.o
        && body(cur) > ab * 2.0 && prev.c < prev.o) {
      patterns.push({
        name: 'VWAP Breakdown', direction: 'bearish',
        strength: Math.min(0.95, 0.63 * Math.min(2, vf)),
        category: 'vwap', emoji: '📊',
        tip: 'Price broke below VWAP with volume — institutional selling',
        description: 'Price lost VWAP from above with volume confirmation. Strong bearish signal.',
        reliability: 0.70, candleIndices: [n - 1],
      });
    }
  }

  // --- 2. Opening Range Breakout (ORB) ---
  if (opts?.orbHigh != null && opts?.orbLow != null) {
    const orbRange = opts.orbHigh - opts.orbLow;
    if (orbRange > 0) {
      if (cur.c > opts.orbHigh && cur.c > cur.o && body(cur) > orbRange * 0.5) {
        patterns.push({
          name: 'ORB Breakout (Bull)', direction: 'bullish',
          strength: Math.min(0.95, 0.70 * Math.min(2, vf)),
          category: 'orb', emoji: '🔓',
          tip: 'Price broke above opening range — strong directional move',
          description: `Price broke above the opening range high (${opts.orbHigh.toFixed(1)}) with conviction.`,
          reliability: 0.75, candleIndices: [n - 1],
        });
      }
      if (cur.c < opts.orbLow && cur.c < cur.o && body(cur) > orbRange * 0.5) {
        patterns.push({
          name: 'ORB Breakdown (Bear)', direction: 'bearish',
          strength: Math.min(0.95, 0.68 * Math.min(2, vf)),
          category: 'orb', emoji: '🔓',
          tip: 'Price broke below opening range — selling pressure',
          description: `Price broke below the opening range low (${opts.orbLow.toFixed(1)}) with conviction.`,
          reliability: 0.73, candleIndices: [n - 1],
        });
      }
    }
  }

  // --- Volume Climax Reversal DISABLED ---
  // iter_02 data: heavily negative across both directions, counter-trend signals unreliable

  // --- Prev Day High/Low Break and Breakout Retest DISABLED ---
  // iter_01 data: these patterns produced 75% of total losses
  // Prev Day High Break: 30% win, -7922 | Breakout Retest (Bull): 15% win, -7471
  // Prev Day Low Break: 18% win, -6157 | Breakout Retest (Bear): 14% win, -2193

  patterns.sort((a, b) => b.strength - a.strength);
  return patterns;
}
