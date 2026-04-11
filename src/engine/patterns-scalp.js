/**
 * Scalping pattern detection — "Hot Mover Pullback" strategy.
 *
 * Strategy rationale (from empirical April 2026 backtest):
 *   Pure ORB breakouts on small caps fail because small caps whipsaw
 *   aggressively around the 9:15-9:30 range. Most "breakouts" are fades.
 *   What DID work on winning days (Apr 2, 6, 10) was chasing stocks that
 *   were ALREADY moving with conviction and entering on small pullbacks.
 *
 * The single pattern fired by this module:
 *
 *   HOT MOVER PULLBACK CONTINUATION
 *
 * Setup for LONG:
 *   1. Past 09:30 (barIndex >= 15)
 *   2. Stock is up >= 1% from the session open (meaningful move)
 *   3. Stock is outperforming the index by >= 0.5% (relative strength)
 *   4. Current price is within 0.4% of the 20-VWAP (a pullback, not a peak)
 *   5. Current bar is bullish (close > open, close > prev close)
 *   6. Current bar has above-average volume (>= 1.3x)
 *   7. EMA5 > EMA13 (trend still intact after pullback)
 *   8. Index direction not bearish
 *   9. Not at the session high (within 0.1%)
 *
 * SHORT is the mirror: stock down >= 1%, underperforming index, pullback
 * to VWAP from below, bearish candle, etc.
 *
 * Why this works (in theory):
 *   - Filters to stocks WITH momentum (already moved 1%+)
 *   - Entry on pullback — not buying the top
 *   - VWAP as the pullback anchor (institutional reference)
 *   - Relative strength = the stock is the strongest in its peer group today
 *   - Multiple confirmations prevent false signals
 */

function ema(candles, period) {
  if (candles.length < period) return null;
  const k = 2 / (period + 1);
  let val = candles[0].c;
  for (let i = 1; i < candles.length; i++) {
    val = candles[i].c * k + val * (1 - k);
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

function volFactor(candles) {
  const n = candles.length;
  if (n < 11) return 1;
  const refVols = candles.slice(n - 11, n - 1).map(c => c.v || 0);
  const avg = refVols.reduce((a, b) => a + b, 0) / refVols.length;
  if (avg <= 0) return 1;
  const tail3 = candles.slice(Math.max(0, n - 4), n - 1).map(c => c.v || 0);
  const tail3avg = tail3.length ? tail3.reduce((a, b) => a + b, 0) / tail3.length : 0;
  const effective = Math.max(candles[n - 1].v || 0, tail3avg);
  return effective / avg;
}

/**
 * @param {Array} candles — full candle array (prior days + current day so far)
 * @param {{
 *   barIndex?: number,
 *   orbHigh?: number, orbLow?: number,
 *   prevDayHigh?: number, prevDayLow?: number,
 *   indexDirection?: { direction, strength, intradayPct? },
 * }} [opts]
 */
export function detectPatterns(candles, opts) {
  if (!candles?.length || candles.length < 20) return [];

  const n = candles.length;
  const cur = candles[n - 1];
  const prev = candles[n - 2];
  const barIndex = opts?.barIndex ?? n;

  // Gate 1: trading window — 09:45 to 10:15 on 1m.
  // Skip first 15 min (opening chop) and last 45 min (not enough room
  // for a 1% target to hit before the 11:00 hard close).
  // Effective window: bars 15..60 on 1m (09:45 to 10:15 from 9:15 start).
  // From the CLI sim's perspective (barIdx 0 = 9:30), this is barIdx 0..45.
  // But we measure barIndex from simulateDay which is window-relative —
  // so 0 = first window bar. Window is 9:30-11:00 = 90 bars. We allow
  // entries in bars 0..45 which is 9:30-10:15.
  if (barIndex > 45) return [];

  // Gate 2: stock intraday move — be STRONG. Must be 1.5%+ from open.
  const dayOpen = opts?.stockDayOpen != null
    ? opts.stockDayOpen
    : (candles[Math.max(0, n - barIndex - 15)]?.o || cur.c);
  const stockIntraPct = (cur.c - dayOpen) / dayOpen;

  // Gate 3: index direction + RS
  const idxDir = opts?.indexDirection || null;
  const idxIntraPct = idxDir?.intradayPct ?? 0;

  // Gate 4: index must be clearly trending (not chop). Skip day if not.
  // The pre-window move is a reliable day-regime proxy; if it's < 0.2%
  // either way, the day is likely chop and scalping fails.
  if (idxDir?.preWindowMove == null) return [];
  const absPreMove = Math.abs(idxDir.preWindowMove);
  if (absPreMove < 0.002) return []; // 0.2% threshold

  // Gate 5: VWAP anchor
  const vwap = vwapProxy(candles, 20);
  if (vwap == null) return [];
  const pullbackPct = Math.abs(cur.c - vwap) / vwap;

  // Gate 6: EMA trend
  const ema5 = ema(candles.slice(-6), 5);
  const ema13 = ema(candles.slice(-14), 13);
  if (ema5 == null || ema13 == null) return [];

  // Gate 7: volume — require strong confirmation (1.5x vs 1.3x earlier)
  const vf = volFactor(candles);
  if (vf < 1.5) return [];

  // Session extremes — don't chase the top/bottom of the day
  const sessionLen = Math.max(1, barIndex + 15);
  const session = candles.slice(-sessionLen);
  const sessionHigh = Math.max(...session.map(c => c.h));
  const sessionLow = Math.min(...session.map(c => c.l));

  // ─── LONG setup ───
  // Strict: stock up 1.5%+, RS 0.8%+, NIFTY trending up, pullback to VWAP.
  const longConditions =
    stockIntraPct >= 0.015 &&                         // up 1.5%+ on the day
    (stockIntraPct - idxIntraPct) >= 0.008 &&         // RS >= 0.8%
    idxDir?.preWindowMove > 0.002 &&                  // NIFTY must be bullish on opening move
    pullbackPct <= 0.003 &&                           // within 0.3% of VWAP (tighter pullback)
    cur.c > vwap &&                                   // above VWAP
    cur.c >= cur.o &&                                 // bullish bar
    cur.c > prev.c &&                                 // upticking
    ema5 > ema13 &&                                   // trend intact
    cur.c < sessionHigh * 0.997;                      // not within 0.3% of session high

  if (longConditions) {
    const rs = stockIntraPct - idxIntraPct;
    return [{
      name: 'Strong Momo Pullback (Long)',
      direction: 'bullish',
      strength: Math.min(0.95, 0.80 + Math.min(0.10, rs * 5) + Math.min(0.05, (vf - 1.5) * 0.1)),
      category: 'momentum',
      emoji: '🔥',
      tip: 'Strong leader pulled back to VWAP, resuming with volume',
      description: `Day +${(stockIntraPct * 100).toFixed(1)}%, RS +${(rs * 100).toFixed(2)}%, vol ${vf.toFixed(1)}x`,
      reliability: 0.80,
      candleIndices: [n - 1],
    }];
  }

  // ─── SHORT setup ───
  const shortConditions =
    stockIntraPct <= -0.015 &&                        // down 1.5%+ on the day
    (idxIntraPct - stockIntraPct) >= 0.008 &&         // RS <= -0.8%
    idxDir?.preWindowMove < -0.002 &&                 // NIFTY must be bearish on opening move
    pullbackPct <= 0.003 &&                           // within 0.3% of VWAP
    cur.c < vwap &&                                   // below VWAP
    cur.c <= cur.o &&                                 // bearish bar
    cur.c < prev.c &&                                 // ticking down
    ema5 < ema13 &&                                   // downtrend intact
    cur.c > sessionLow * 1.003;                       // not within 0.3% of session low

  if (shortConditions) {
    const rs = idxIntraPct - stockIntraPct;
    return [{
      name: 'Strong Momo Pullback (Short)',
      direction: 'bearish',
      strength: Math.min(0.95, 0.80 + Math.min(0.10, rs * 5) + Math.min(0.05, (vf - 1.5) * 0.1)),
      category: 'momentum',
      emoji: '❄️',
      tip: 'Strong loser bounced into VWAP, rolling over with volume',
      description: `Day ${(stockIntraPct * 100).toFixed(1)}%, RS -${(rs * 100).toFixed(2)}%, vol ${vf.toFixed(1)}x`,
      reliability: 0.80,
      candleIndices: [n - 1],
    }];
  }

  return [];
}
