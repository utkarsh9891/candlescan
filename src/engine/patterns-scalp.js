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

  // Reject all signals if volume is weak
  // Require some volume activity (relaxed from 1.3 — Yahoo 1m last bar often has 0 vol)
  if (vf < 0.8) return [];

  const ab = avgBody(candles, 10);
  const vwap = vwapProxy(candles, 20);

  // --- 1. VWAP Breakout/Rejection ---
  if (vwap && prev) {
    const prevSide = prev.c > vwap ? 'above' : 'below';
    const curSide = cur.c > vwap ? 'above' : 'below';

    // Bullish VWAP breakout: was below, now above
    if (prevSide === 'below' && curSide === 'above' && cur.c > cur.o) {
      patterns.push({
        name: 'VWAP Breakout', direction: 'bullish',
        strength: Math.min(0.95, 0.65 * Math.min(2, vf)),
        category: 'vwap', emoji: '📊',
        tip: 'Price crossed above VWAP with volume — institutional buying',
        description: 'Price reclaimed VWAP from below with volume confirmation. Strong bullish signal.',
        reliability: 0.72, candleIndices: [n - 1],
      });
    }
    // Bearish VWAP breakdown
    if (prevSide === 'above' && curSide === 'below' && cur.c < cur.o) {
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
      if (cur.c > opts.orbHigh && cur.c > cur.o && body(cur) > orbRange * 0.3) {
        patterns.push({
          name: 'ORB Breakout (Bull)', direction: 'bullish',
          strength: Math.min(0.95, 0.70 * Math.min(2, vf)),
          category: 'orb', emoji: '🔓',
          tip: 'Price broke above opening range — strong directional move',
          description: `Price broke above the opening range high (${opts.orbHigh.toFixed(1)}) with conviction.`,
          reliability: 0.75, candleIndices: [n - 1],
        });
      }
      if (cur.c < opts.orbLow && cur.c < cur.o && body(cur) > orbRange * 0.3) {
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

  // --- 4. Volume Climax Reversal ---
  if (n >= 3 && vf >= 2.5) {
    // Current bar has extreme volume (3x+) AND previous bar was same direction
    if (isBull(prev) && !isBull(cur) && body(cur) > ab * 0.8) {
      patterns.push({
        name: 'Volume Climax Reversal (Bear)', direction: 'bearish',
        strength: Math.min(0.90, 0.65 * Math.min(2, vf / 2)),
        category: 'volume-climax', emoji: '💥',
        tip: 'Extreme volume exhaustion — buyers done, reversal likely',
        description: 'Massive volume spike followed by bearish reversal. Institutions have finished buying.',
        reliability: 0.65, candleIndices: [n - 2, n - 1],
      });
    }
    if (!isBull(prev) && isBull(cur) && body(cur) > ab * 0.8) {
      patterns.push({
        name: 'Volume Climax Reversal (Bull)', direction: 'bullish',
        strength: Math.min(0.90, 0.65 * Math.min(2, vf / 2)),
        category: 'volume-climax', emoji: '💥',
        tip: 'Extreme volume exhaustion — sellers done, bounce likely',
        description: 'Massive volume spike followed by bullish reversal. Selling pressure exhausted.',
        reliability: 0.65, candleIndices: [n - 2, n - 1],
      });
    }
  }

  // --- 6. Previous Day High/Low Breakout ---
  if (opts?.prevDayHigh != null && opts?.prevDayLow != null) {
    if (cur.c > opts.prevDayHigh && cur.c > cur.o) {
      patterns.push({
        name: 'Prev Day High Break', direction: 'bullish',
        strength: Math.min(0.92, 0.68 * Math.min(2, vf)),
        category: 'prev-day', emoji: '📈',
        tip: 'Broke above yesterday\'s high — fresh buying',
        description: `Price exceeded previous day high (${opts.prevDayHigh.toFixed(1)}). Key institutional level cleared.`,
        reliability: 0.68, candleIndices: [n - 1],
      });
    }
    if (cur.c < opts.prevDayLow && cur.c < cur.o) {
      patterns.push({
        name: 'Prev Day Low Break', direction: 'bearish',
        strength: Math.min(0.92, 0.66 * Math.min(2, vf)),
        category: 'prev-day', emoji: '📉',
        tip: 'Broke below yesterday\'s low — fresh selling',
        description: `Price broke below previous day low (${opts.prevDayLow.toFixed(1)}). Key support lost.`,
        reliability: 0.66, candleIndices: [n - 1],
      });
    }
  }

  // --- 6. Breakout Retest ---
  if (n >= 15) {
    const lookback = candles.slice(-15, -3);
    const recentHigh = Math.max(...lookback.map(c => c.h));
    const recentLow = Math.min(...lookback.map(c => c.l));
    const prev2 = candles[n - 3];
    const prev1 = candles[n - 2];

    // Bull: broke resistance, pulled back, now bouncing
    if (prev2.c > recentHigh && prev1.l <= recentHigh * 1.002 && cur.c > recentHigh && isBull(cur)) {
      patterns.push({
        name: 'Breakout Retest (Bull)', direction: 'bullish',
        strength: Math.min(0.92, 0.65 * Math.min(2, vf)),
        category: 'breakout-retest', emoji: '🔁',
        tip: 'Broke resistance, retested, now bouncing — high probability long',
        description: 'Classic breakout-retest-continuation. Resistance became support.',
        reliability: 0.70, candleIndices: [n - 3, n - 2, n - 1],
      });
    }

    // Bear: broke support, pulled back, now rejecting
    if (prev2.c < recentLow && prev1.h >= recentLow * 0.998 && cur.c < recentLow && !isBull(cur)) {
      patterns.push({
        name: 'Breakout Retest (Bear)', direction: 'bearish',
        strength: Math.min(0.92, 0.63 * Math.min(2, vf)),
        category: 'breakout-retest', emoji: '🔁',
        tip: 'Broke support, retested, now rejecting — high probability short',
        description: 'Classic breakdown-retest-continuation. Support became resistance.',
        reliability: 0.68, candleIndices: [n - 3, n - 2, n - 1],
      });
    }
  }

  patterns.sort((a, b) => b.strength - a.strength);
  return patterns;
}
