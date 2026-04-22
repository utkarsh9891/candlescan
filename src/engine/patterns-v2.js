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
 * Day-session VWAP proxy — typical price weighted by volume across the
 * passed candles. Used by the momentum-runner trigger to confirm that
 * price is holding above (or below) the institutional volume anchor.
 */
function vwapAcross(candles) {
  if (!candles?.length) return null;
  let pv = 0, v = 0;
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    pv += tp * (c.v || 0);
    v += (c.v || 0);
  }
  return v > 0 ? pv / v : null;
}

/**
 * Intraday Momentum Runner trigger (PR-C). Fires on stocks that are
 * already up ≥3% (or down ≥3%) from session open with volume ≥2× the
 * trailing 10-bar average and price holding the right side of VWAP.
 *
 * The peer-validated reference trades (MMFL +19.6%, SAILIFE +12%,
 * ASHAPURMIN +10%, REFEX +1.9-5.4%, RRKABEL +6.2%, GRAPHITE +1.3-2.6%,
 * SYRMA +2.4-6%) all share this shape: smallcap that gaps + sustains
 * a strong morning move on heavy volume. The existing reversal-pattern
 * suite (engulfing/piercing/hammer) misreads these as exhaustion tops
 * and fires SHORT — the replay script (PR-A2) showed 5/8 wrong-direction
 * fires on intraday timeframes.
 *
 * Strict gates so this isn't a noise pump:
 *   - barIndex in [3, 50] (skip first 15 min, cap at ~4 hours on 5m)
 *   - stockIntraPct ≥ 3% from session open (mirror ≤ -3% for short)
 *   - volFactor ≥ 2.0 (institutional confirmation)
 *   - cur.c > vwap (long) / cur.c < vwap (short)
 *   - cur is bullish (long) / bearish (short) — no exhaustion bar
 *   - if indexDirection.intradayPct available: stock_pct - index_pct ≥ 2% (relative strength)
 *   - no recent failed breakout: in last 6 bars no failed-high (high > prior 5-bar high but close < that high)
 *
 * Strength 0.88-0.95 so it dominates the reversal patterns (which max
 * out at ~0.85). Caller's risk scorer will then apply the multi-factor
 * confluence + R:R scoring.
 */
function detectMomentumRunner(candles, opts) {
  const n = candles.length;
  if (n < 12) return null;
  const barIndex = opts?.barIndex ?? n;
  if (barIndex < 3 || barIndex > 50) return null;

  // Session open: prefer caller-provided (simulator passes stockDayOpen);
  // fall back to candles[0].o (replay-script case where candles == today's bars only).
  const dayOpen = opts?.stockDayOpen ?? candles[0]?.o;
  if (!dayOpen || dayOpen <= 0) return null;

  const cur = candles[n - 1];
  const stockIntraPct = (cur.c - dayOpen) / dayOpen;

  // Volume gate: 2x trailing 10-bar avg
  const volSlice = candles.slice(Math.max(0, n - 11), n - 1).map(c => c.v || 0);
  const avgVol = volSlice.length ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
  if (avgVol <= 0) return null;
  const vf = (cur.v || 0) / avgVol;
  if (vf < 2.0) return null;

  // VWAP confirmation across the window the caller showed us.
  const vwap = vwapAcross(candles);
  if (vwap == null) return null;

  // Failed-breakout filter: in the last 6 bars, was there a bar where
  // high pierced a prior 5-bar high but close fell back below it? That
  // indicates supply zones still active above — this is NOT a clean runner.
  const failedRangeStart = Math.max(5, n - 6);
  for (let i = failedRangeStart; i < n - 1; i++) {  // exclude cur from check
    const lookback = candles.slice(Math.max(0, i - 5), i);
    if (lookback.length < 3) continue;
    const priorHigh = Math.max(...lookback.map(c => c.h));
    const priorLow = Math.min(...lookback.map(c => c.l));
    const bar = candles[i];
    if (bar.h > priorHigh && bar.c < priorHigh) return null;  // failed long breakout
    if (bar.l < priorLow && bar.c > priorLow) return null;    // failed short breakdown
  }

  const indexPct = opts?.indexDirection?.intradayPct ?? null;

  // LONG runner
  if (stockIntraPct >= 0.03 && isBull(cur) && cur.c > vwap) {
    if (indexPct != null && (stockIntraPct - indexPct) < 0.02) return null;  // RS gate
    // Strength scales with magnitude + volume + RS bonus, capped at 0.95.
    let strength = 0.88 + Math.min(0.05, (stockIntraPct - 0.03) * 0.5);
    strength += Math.min(0.02, (vf - 2.0) * 0.01);
    strength = Math.min(0.95, strength);
    return {
      name: 'Intraday Momentum Runner',
      direction: 'bullish',
      strength,
      category: 'momentum',
      emoji: '🚀',
      tip: `Stock +${(stockIntraPct * 100).toFixed(1)}% with ${vf.toFixed(1)}× volume above VWAP — ride the trend`,
      description: 'Strong morning move (≥3%) holding above VWAP on heavy volume. Continuation setup.',
      // Reliability 0.72 (peer-validated trades shape — see PR-A2 replay).
      // Higher than first-pullback (0.55) because the explicit volume +
      // VWAP + RS gates rule out most false positives.
      reliability: 0.72,
      candleIndices: [n - 1],
    };
  }
  // SHORT runner (mirror)
  if (stockIntraPct <= -0.03 && !isBull(cur) && cur.c < vwap) {
    if (indexPct != null && (indexPct - stockIntraPct) < 0.02) return null;
    let strength = 0.88 + Math.min(0.05, (-stockIntraPct - 0.03) * 0.5);
    strength += Math.min(0.02, (vf - 2.0) * 0.01);
    strength = Math.min(0.95, strength);
    return {
      name: 'Intraday Momentum Runner',
      direction: 'bearish',
      strength,
      category: 'momentum',
      emoji: '⬇️',
      tip: `Stock ${(stockIntraPct * 100).toFixed(1)}% with ${vf.toFixed(1)}× volume below VWAP — ride the trend`,
      description: 'Strong morning move (≤-3%) holding below VWAP on heavy volume. Continuation setup.',
      reliability: 0.72,
      candleIndices: [n - 1],
    };
  }
  return null;
}

/**
 * @param {Candle[]} candles
 * @param {{ barIndex?: number, stockDayOpen?: number, indexDirection?: object }} [opts]
 *   - barIndex: 0-based position in session (suppresses early-session momentum)
 *   - stockDayOpen: today's session open price (enables Intraday Momentum Runner)
 *   - indexDirection: { intradayPct } for relative-strength filter
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

  /* --- Intraday Momentum Runner (PR-C, primary intraday P&L lever) --- */
  // Strict gates inside detectMomentumRunner (3%+ from open, 2× volume,
  // VWAP confirmation, RS check, no failed breakouts). When it fires the
  // strength (0.88-0.95) sorts it above the reversal patterns, so the
  // V2 risk scorer picks it as `top` and downstream confluence/RR scoring
  // applies. Replay validation (PR-A2) showed 5/8 reference trades had
  // no momentum-friendly pattern in the engine; this fixes that.
  const runner = detectMomentumRunner(candles, opts);
  if (runner) patterns.push(runner);

  patterns.sort((a, b) => b.strength - a.strength);
  return patterns;
}
