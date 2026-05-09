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
    // Index-direction veto (Wave 3 iter 1): never long a runner when the
    // index is materially down. Choppy / counter-trend rallies on bad
    // market days produced the Apr 8 -Rs 48k drawdown from 0W/4L all-loss
    // momentum-runner cluster. Threshold -0.5%: small index pullbacks OK,
    // crashes vetoed.
    if (indexPct != null && indexPct <= -0.005) return null;
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
    // Index-direction veto (mirror): don't short a runner when the index
    // is rallying strongly — counter-trend shorts get squeezed.
    if (indexPct != null && indexPct >= 0.005) return null;
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
 * Trend Continuation Pullback (v11 — peer-validated independent backtest).
 *
 * Ports the `h3_trend_continuation` strategy from
 * `cache/independent-analysis/strategies_v5.py` — the proven winner across
 * the 5-disjoint-run validation that hit 70-78% trade-WR with morning-only
 * entries. The pattern fires when:
 *
 *   - First-hour move (bars 0-11 on 5m = 9:15-10:15 IST) ≥ 0.7% in one
 *     direction and ≥ 1.5× the opposite tail. Defines the day's bias.
 *   - 30m and 60m bars aligned with that bias (close > open for LONG).
 *   - Current bar's low touches within 0.2% of session VWAP (LONG); mirror
 *     for SHORT.
 *   - Current bar is a bouncing bar in trend direction (close > open and
 *     close > VWAP for LONG) with volume ≥ 2× prior 6-bar avg.
 *   - Liquidity gate: first 30 min turnover ≥ Rs 1cr (sum of close*vol).
 *   - barIndex ≥ 13 (post-first-hour) and ≤ 50 (no late-day chop).
 *   - Optional morning-only filter: opts.morningOnly !== false will reject
 *     entries after 10:30 IST. Default ON when the simulator/scan supplies
 *     a stockDayOpen + barIndex.
 *
 * Why a separate pattern from Momentum Runner:
 *   - Runner fires on +3% breakouts mid-rally — different setup, different
 *     SL/target shape. Pullback fires on +0.7% trends after a return to
 *     VWAP, which is structurally a higher-probability mean-reversion
 *     entry within an established intraday trend.
 *   - Risk side: pullback wants tight 0.4% target with structure-based SL
 *     (min(low, vwap)*0.998) — that maps to 3-tranche partial exits in
 *     the simulator; runner wants the 8% target ladder.
 *
 * Strength 0.80-0.86 — sits below the runner (0.88-0.95) but above the
 * reversal patterns (0.55-0.75) so the v2 risk scorer's `top` selection
 * favors a runner if both fire on the same bar (they rarely do — runner
 * needs price > VWAP +3%, pullback needs price ≈ VWAP).
 */
function detectTrendContPullback(candles, opts) {
  const n = candles.length;
  // Need first hour (12 bars) + at least 1 post-hour bar for the trigger.
  if (n < 13) return null;
  const barIndex = opts?.barIndex ?? n;
  // Need first hour established (bars 0-11) plus at least 1 post-window bar.
  if (barIndex < 13 || barIndex > 50) return null;

  const dayOpen = opts?.stockDayOpen ?? candles[0]?.o;
  if (!dayOpen || dayOpen <= 0) return null;

  // Liquidity gate: first 6 bars (30 min) turnover ≥ Rs 1cr.
  let firstWindowTurnover = 0;
  const firstSlice = candles.slice(0, Math.min(6, candles.length));
  for (const c of firstSlice) firstWindowTurnover += (c.c || 0) * (c.v || 0);
  if (firstWindowTurnover < 1_00_00_000) return null;

  // Morning-only filter (default ON): skip entries after 10:30 IST.
  // Caller can override via opts.morningOnly === false.
  const morningOnly = opts?.morningOnly !== false;
  if (morningOnly) {
    const cur = candles[n - 1];
    if (cur.t) {
      const istSec = cur.t + 19800; // +5:30
      const minsOfDay = Math.floor((istSec % 86400) / 60);
      // 10:30 IST = 630 minutes past midnight UTC+5:30
      if (minsOfDay > 630) return null;
    }
  }

  // First-hour move: bars 0..11 (12 bars × 5m = 60 min on 5m timeframe).
  const firstHourBars = candles.slice(0, Math.min(12, candles.length));
  if (firstHourBars.length < 12) return null;
  const fhHigh = Math.max(...firstHourBars.map(c => c.h));
  const fhLow = Math.min(...firstHourBars.map(c => c.l));
  const moveUp = (fhHigh - dayOpen) / dayOpen;
  const moveDn = (dayOpen - fhLow) / dayOpen;
  let direction = null;
  if (moveUp >= 0.007 && moveUp > moveDn * 1.5) direction = 'bullish';
  else if (moveDn >= 0.007 && moveDn > moveUp * 1.5) direction = 'bearish';
  if (!direction) return null;

  // 30m / 60m alignment with first-hour direction. Build aggregates from the
  // bars we have so far (pre-window included).
  const build = (n, k) => {
    const out = [];
    for (let i = 0; i + k <= n.length; i += k) {
      const ch = n.slice(i, i + k);
      out.push({
        o: ch[0].o,
        h: Math.max(...ch.map(b => b.h)),
        l: Math.min(...ch.map(b => b.l)),
        c: ch[ch.length - 1].c,
      });
    }
    return out;
  };
  const bars30 = build(candles.slice(0, n), 6);
  const bars60 = build(candles.slice(0, n), 12);
  if (!bars30.length || !bars60.length) return null;
  const lastB30 = bars30[bars30.length - 1];
  const lastB60 = bars60[bars60.length - 1];
  const bull30 = lastB30.c > lastB30.o;
  const bull60 = lastB60.c > lastB60.o;
  if (direction === 'bullish' && !(bull30 && bull60)) return null;
  if (direction === 'bearish' && (bull30 || bull60)) return null;

  // Session VWAP up to and including the current bar.
  const vwap = vwapAcross(candles);
  if (vwap == null) return null;

  // Volume gate: cur ≥ 2× prior 6-bar avg.
  const cur = candles[n - 1];
  const priorVols = candles.slice(Math.max(0, n - 7), n - 1).map(c => c.v || 0);
  const priorVAvg = priorVols.length
    ? priorVols.reduce((a, b) => a + b, 0) / priorVols.length
    : 0;
  if (priorVAvg <= 0 || (cur.v || 0) < 2.0 * priorVAvg) return null;

  if (direction === 'bullish') {
    // Pulled to within 0.2% of VWAP from above.
    const pulled = Math.abs(cur.l - vwap) / vwap < 0.002;
    // Bouncing: bullish bar that closes back above VWAP.
    const bouncing = cur.c > cur.o && cur.c > vwap;
    if (!pulled || !bouncing) return null;
    // Stop sanity: structure SL must be within 0.25%-0.8% from close.
    const slPx = Math.min(cur.l, vwap) * 0.998;
    const slDistPct = (cur.c - slPx) / cur.c;
    if (slDistPct < 0.0025 || slDistPct > 0.008) return null;

    // Strength scales with first-hour magnitude + volume burst, capped 0.86.
    const volRatio = (cur.v || 0) / priorVAvg;
    let strength = 0.80 + Math.min(0.04, (moveUp - 0.007) * 4);
    strength += Math.min(0.02, (volRatio - 2.0) * 0.005);
    strength = Math.min(0.86, strength);

    return {
      name: 'Trend Continuation Pullback',
      direction: 'bullish',
      strength,
      category: 'pullback',
      emoji: '↗️',
      tip: `1h up +${(moveUp * 100).toFixed(2)}%, pulled to VWAP, vol ${volRatio.toFixed(1)}× — ride trend`,
      description: 'Strong morning trend with VWAP pullback + volume bounce. Continuation entry.',
      // Reliability 0.70 — peer-validated by independent 5-run backtest
      // (70-78% trade-WR mean across disjoint stock universes, Mar-May
      // 2026; see cache/independent-analysis/REFERENCE.md).
      reliability: 0.70,
      candleIndices: [n - 1],
      // Hint for the v2 risk scorer: structure-based SL + tight target.
      _structureSL: slPx,
      _firstHourMove: moveUp,
    };
  }

  // SHORT mirror.
  const pulled = Math.abs(cur.h - vwap) / vwap < 0.002;
  const bouncing = cur.c < cur.o && cur.c < vwap;
  if (!pulled || !bouncing) return null;
  const slPx = Math.max(cur.h, vwap) * 1.002;
  const slDistPct = (slPx - cur.c) / cur.c;
  if (slDistPct < 0.0025 || slDistPct > 0.008) return null;

  const volRatio = (cur.v || 0) / priorVAvg;
  let strength = 0.80 + Math.min(0.04, (moveDn - 0.007) * 4);
  strength += Math.min(0.02, (volRatio - 2.0) * 0.005);
  strength = Math.min(0.86, strength);

  return {
    name: 'Trend Continuation Pullback',
    direction: 'bearish',
    strength,
    category: 'pullback',
    emoji: '↘️',
    tip: `1h down -${(moveDn * 100).toFixed(2)}%, pulled to VWAP, vol ${volRatio.toFixed(1)}× — ride trend`,
    description: 'Strong morning down-trend with VWAP pullback + volume rejection. Continuation entry.',
    reliability: 0.70,
    candleIndices: [n - 1],
    _structureSL: slPx,
    _firstHourMove: moveDn,
  };
}

/**
 * @param {Candle[]} candles
 * @param {{ barIndex?: number, stockDayOpen?: number, indexDirection?: object, morningOnly?: boolean }} [opts]
 *   - barIndex: 0-based position in session (suppresses early-session momentum)
 *   - stockDayOpen: today's session open price (enables Intraday Momentum Runner +
 *     Trend Continuation Pullback)
 *   - indexDirection: { intradayPct } for relative-strength filter
 *   - morningOnly: if true (default), Trend Continuation Pullback only fires
 *     ≤ 10:30 IST. Pass `false` to allow all-day pullback entries.
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

  /* --- Trend Continuation Pullback (v11 morning-only, peer-validated) --- */
  // Independent 5-run disjoint backtest (mid+smallcap NIFTY 500, Mar-May
  // 2026) hit 70-78% trade-WR with morning-only entries + 3-tranche
  // partial exits. Risk scorer reads `_structureSL` to anchor the stop
  // just below VWAP/pullback low instead of ATR×2.
  const pullback = detectTrendContPullback(candles, opts);
  if (pullback) patterns.push(pullback);

  patterns.sort((a, b) => b.strength - a.strength);
  return patterns;
}
