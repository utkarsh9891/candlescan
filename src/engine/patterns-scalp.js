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
  return Math.min(3, (candles[n - 1].v || 0) / avg);
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
  if (vf < 1.3) return [];

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
        reliability: 0.68, candleIndices: [n - 1],
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
        reliability: 0.66, candleIndices: [n - 1],
      });
    }
    // VWAP rejection: touched VWAP but bounced off
    if (curSide === 'above' && cur.l <= vwap * 1.001 && cur.c > vwap * 1.002) {
      patterns.push({
        name: 'VWAP Rejection (Bull)', direction: 'bullish',
        strength: Math.min(0.90, 0.60 * Math.min(2, vf)),
        category: 'vwap', emoji: '📊',
        tip: 'Price bounced off VWAP support',
        description: 'Price dipped to VWAP and bounced — VWAP acting as support.',
        reliability: 0.62, candleIndices: [n - 1],
      });
    }
  }

  // --- 2. Micro Momentum Burst ---
  if (n >= 4) {
    const last3 = candles.slice(-3);
    const allBull = last3.every(c => isBull(c));
    const allBear = last3.every(c => !isBull(c));
    const volIncreasing = last3[0].v < last3[1].v && last3[1].v < last3[2].v;

    if (allBull && volIncreasing && body(cur) > ab * 1.2) {
      patterns.push({
        name: 'Micro Momentum (Bull)', direction: 'bullish',
        strength: Math.min(0.90, 0.55 + (body(cur) / (ab * 4)) * 0.3),
        category: 'micro-momentum', emoji: '🚀',
        tip: '3 green candles with rising volume — momentum building',
        description: 'Three consecutive bullish candles with increasing volume. Ride the wave.',
        reliability: 0.60, candleIndices: [n - 3, n - 2, n - 1],
      });
    }
    if (allBear && volIncreasing && body(cur) > ab * 1.2) {
      patterns.push({
        name: 'Micro Momentum (Bear)', direction: 'bearish',
        strength: Math.min(0.90, 0.53 + (body(cur) / (ab * 4)) * 0.3),
        category: 'micro-momentum', emoji: '⬇️',
        tip: '3 red candles with rising volume — selling pressure',
        description: 'Three consecutive bearish candles with increasing volume. Short opportunity.',
        reliability: 0.58, candleIndices: [n - 3, n - 2, n - 1],
      });
    }
  }

  // --- 3. Opening Range Breakout (ORB) ---
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
          reliability: 0.70, candleIndices: [n - 1],
        });
      }
      if (cur.c < opts.orbLow && cur.c < cur.o && body(cur) > orbRange * 0.3) {
        patterns.push({
          name: 'ORB Breakdown (Bear)', direction: 'bearish',
          strength: Math.min(0.95, 0.68 * Math.min(2, vf)),
          category: 'orb', emoji: '🔓',
          tip: 'Price broke below opening range — selling pressure',
          description: `Price broke below the opening range low (${opts.orbLow.toFixed(1)}) with conviction.`,
          reliability: 0.68, candleIndices: [n - 1],
        });
      }
    }
  }

  // --- 4. EMA Crossover (5/13) ---
  if (n >= 15) {
    const ema5now = ema(candles.slice(-6), 5);
    const ema13now = ema(candles.slice(-14), 13);
    const ema5prev = ema(candles.slice(-7, -1), 5);
    const ema13prev = ema(candles.slice(-15, -1), 13);

    if (ema5now && ema13now && ema5prev && ema13prev) {
      // Bullish crossover: EMA5 was below EMA13, now above
      if (ema5prev <= ema13prev && ema5now > ema13now) {
        patterns.push({
          name: 'EMA Cross (Bull)', direction: 'bullish',
          strength: Math.min(0.85, 0.58 * Math.min(1.8, vf)),
          category: 'ema-cross', emoji: '✕',
          tip: 'EMA 5 crossed above EMA 13 — trend turning bullish',
          description: 'Short-term EMA crossed above medium-term EMA. Trend shift signal.',
          reliability: 0.55, candleIndices: [n - 1],
        });
      }
      // Bearish crossover
      if (ema5prev >= ema13prev && ema5now < ema13now) {
        patterns.push({
          name: 'EMA Cross (Bear)', direction: 'bearish',
          strength: Math.min(0.85, 0.56 * Math.min(1.8, vf)),
          category: 'ema-cross', emoji: '✕',
          tip: 'EMA 5 crossed below EMA 13 — trend turning bearish',
          description: 'Short-term EMA crossed below medium-term EMA. Trend shift signal.',
          reliability: 0.53, candleIndices: [n - 1],
        });
      }
    }
  }

  // --- 5. Volume Climax Reversal ---
  if (n >= 3 && vf >= 3.0) {
    // Current bar has extreme volume (3x+) AND previous bar was same direction
    if (isBull(prev) && !isBull(cur) && body(cur) > ab * 0.8) {
      patterns.push({
        name: 'Volume Climax Reversal (Bear)', direction: 'bearish',
        strength: Math.min(0.90, 0.65 * Math.min(2, vf / 2)),
        category: 'volume-climax', emoji: '💥',
        tip: 'Extreme volume exhaustion — buyers done, reversal likely',
        description: 'Massive volume spike followed by bearish reversal. Institutions have finished buying.',
        reliability: 0.62, candleIndices: [n - 2, n - 1],
      });
    }
    if (!isBull(prev) && isBull(cur) && body(cur) > ab * 0.8) {
      patterns.push({
        name: 'Volume Climax Reversal (Bull)', direction: 'bullish',
        strength: Math.min(0.90, 0.65 * Math.min(2, vf / 2)),
        category: 'volume-climax', emoji: '💥',
        tip: 'Extreme volume exhaustion — sellers done, bounce likely',
        description: 'Massive volume spike followed by bullish reversal. Selling pressure exhausted.',
        reliability: 0.62, candleIndices: [n - 2, n - 1],
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
        reliability: 0.65, candleIndices: [n - 1],
      });
    }
    if (cur.c < opts.prevDayLow && cur.c < cur.o) {
      patterns.push({
        name: 'Prev Day Low Break', direction: 'bearish',
        strength: Math.min(0.92, 0.66 * Math.min(2, vf)),
        category: 'prev-day', emoji: '📉',
        tip: 'Broke below yesterday\'s low — fresh selling',
        description: `Price broke below previous day low (${opts.prevDayLow.toFixed(1)}). Key support lost.`,
        reliability: 0.63, candleIndices: [n - 1],
      });
    }
  }

  // --- 7. Micro Double Bottom/Top ---
  if (n >= 20) {
    const lookback = candles.slice(-20, -1);
    const curLow = cur.l;
    const curHigh = cur.h;
    const tolerance = range(cur) * 0.3 || 0.5;

    // Double bottom: find a prior bar with similar low, current bouncing
    const priorBottomIdx = lookback.findIndex(c =>
      Math.abs(c.l - curLow) < tolerance && isBull(cur) && cur.c > cur.o
    );
    if (priorBottomIdx >= 0 && priorBottomIdx < 15 && isBull(cur)) {
      patterns.push({
        name: 'Micro Double Bottom', direction: 'bullish',
        strength: Math.min(0.85, 0.58 * Math.min(1.8, vf)),
        category: 'micro-double', emoji: 'W',
        tip: 'Double bounce off same level — support confirmed',
        description: 'Price tested the same low twice and bounced. Micro support confirmed.',
        reliability: 0.58, candleIndices: [n - 20 + priorBottomIdx, n - 1],
      });
    }

    // Double top
    const priorTopIdx = lookback.findIndex(c =>
      Math.abs(c.h - curHigh) < tolerance && !isBull(cur) && cur.c < cur.o
    );
    if (priorTopIdx >= 0 && priorTopIdx < 15 && !isBull(cur)) {
      patterns.push({
        name: 'Micro Double Top', direction: 'bearish',
        strength: Math.min(0.85, 0.56 * Math.min(1.8, vf)),
        category: 'micro-double', emoji: 'M',
        tip: 'Double rejection at same level — resistance confirmed',
        description: 'Price tested the same high twice and rejected. Micro resistance confirmed.',
        reliability: 0.56, candleIndices: [n - 20 + priorTopIdx, n - 1],
      });
    }
  }

  patterns.sort((a, b) => b.strength - a.strength);
  return patterns;
}
