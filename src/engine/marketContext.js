/**
 * Market context layer — combines all non-OHLC signals that influence
 * trade quality. Shipped incrementally per 2026-04 multi-factor work.
 *
 * Layers aggregated here:
 *   1. India VIX regime            (src: ^INDIAVIX daily close)
 *   2. Pre-market / overnight gap  (src: prev day close vs today's open)
 *   3. Liquidity / spread proxy    (src: stock's avg daily volume)
 *   4. FII/DII institutional flow  (src: NSE public endpoint, daily)
 *   5. News / catalyst sentiment   (src: Yahoo Finance news, scored)
 *
 * Each layer produces a small, composable signal that the pattern/risk
 * engine can read. None is required — all are optional inputs that
 * the engine weighs into its confidence calculation. When any layer's
 * data is missing the engine treats it as neutral (no boost, no veto).
 *
 * Design goals:
 *   - Pure functions (no network calls) — the sim caches feed this
 *   - Explicit null for "no data" vs false for "neutral"
 *   - Small API surface — one classifier per layer, one composer
 */

// ─── Layer 1: VIX regime ────────────────────────────────────────────

/**
 * Classify India VIX into a trading regime.
 *
 * Thresholds calibrated empirically against the Mar-Apr 2026 regime
 * where India VIX oscillated between 18 and 28 (a persistent elevated-
 * vol window driven by macro and geopolitics). The original thresholds
 * (14/18/24) classified every April day as HIGH or PANIC and broke the
 * backtest entirely — recalibrated higher to reflect that a VIX of 22
 * is "normal for this macro regime, not exceptional".
 *
 * - LOW    (vix < 16)    : clean trends, scalping edge strongest
 * - NORMAL (16..22)      : typical for 2026 elevated regime
 * - HIGH   (22..28)      : genuinely elevated, reduce size / tighten
 * - PANIC  (>= 28)       : extreme, scalping noise overwhelms signal
 *
 * @param {number} vixClose
 * @returns {'LOW'|'NORMAL'|'HIGH'|'PANIC'|null}
 */
export function vixRegime(vixClose) {
  if (vixClose == null || !Number.isFinite(vixClose)) return null;
  if (vixClose < 16) return 'LOW';
  if (vixClose < 22) return 'NORMAL';
  if (vixClose < 28) return 'HIGH';
  return 'PANIC';
}

/**
 * Should this regime allow any scalp trades at all?
 * PANIC regimes are hard-gated off because the noise floor exceeds
 * the 0.5% SL distance — every setup gets stopped out on chop.
 */
export function vixAllowsTrading(regime) {
  return regime !== 'PANIC';
}

/**
 * Confidence adjustment for a given regime.
 * Minimal deltas — big deltas changed candidate ranking and hurt P&L
 * in the backtest. Keep the PANIC veto (which is a hard gate, not a
 * ranking shift) but make NORMAL/HIGH regime-neutral.
 * @returns {number} additive confidence bonus (signed)
 */
export function vixConfidenceDelta(regime) {
  switch (regime) {
    case 'LOW':    return +2;
    case 'NORMAL': return  0;
    case 'HIGH':   return  0;      // no penalty — changes ranking too much
    case 'PANIC':  return -99;     // effectively rejects
    default:       return  0;
  }
}

// ─── Layer 2: Pre-market gap ────────────────────────────────────────

/**
 * Classify an overnight gap.
 * - GAP_UP_STRONG   : +1% or more — continuation day, favor longs
 * - GAP_UP          : +0.3% to +1% — mild bullish bias
 * - FLAT            : within +/- 0.3% — no gap signal
 * - GAP_DOWN        : -0.3% to -1% — mild bearish bias
 * - GAP_DOWN_STRONG : -1% or more — continuation, favor shorts
 *
 * Strong gaps on small caps usually continue in gap direction for the
 * first 30-60 minutes, then either hold or reverse (gap fill).
 *
 * @param {number} prevClose
 * @param {number} todayOpen
 * @returns {'GAP_UP_STRONG'|'GAP_UP'|'FLAT'|'GAP_DOWN'|'GAP_DOWN_STRONG'|null}
 */
export function classifyGap(prevClose, todayOpen) {
  if (!prevClose || !todayOpen) return null;
  const gap = (todayOpen - prevClose) / prevClose;
  if (gap >= 0.01) return 'GAP_UP_STRONG';
  if (gap >= 0.003) return 'GAP_UP';
  if (gap <= -0.01) return 'GAP_DOWN_STRONG';
  if (gap <= -0.003) return 'GAP_DOWN';
  return 'FLAT';
}

/**
 * Does a stock's gap classification align with a trade direction?
 * Used as a soft filter — alignment boosts confidence, misalignment
 * penalizes. Small caps that gap in the opposite direction to the
 * trade have historically much lower follow-through.
 *
 * @returns {+1 | 0 | -1}  alignment: +1 aligned, 0 neutral, -1 counter
 */
export function gapAlignment(gap, direction) {
  if (gap == null || gap === 'FLAT') return 0;
  const isBullishGap = gap === 'GAP_UP' || gap === 'GAP_UP_STRONG';
  const isBearishGap = gap === 'GAP_DOWN' || gap === 'GAP_DOWN_STRONG';
  if (direction === 'long')  return isBullishGap ? +1 : isBearishGap ? -1 : 0;
  if (direction === 'short') return isBearishGap ? +1 : isBullishGap ? -1 : 0;
  return 0;
}

// ─── Layer 3: Liquidity / spread proxy ──────────────────────────────

/**
 * Classify a stock's liquidity from its PER-BAR average volume in the
 * trading window. The sim passes `avgVol` computed as the mean volume
 * across the 1-minute bars of the 9:30-11:00 window, NOT the full-day
 * total. Thresholds calibrated for that measurement (90-bar window).
 *
 * Approximate full-day volume for each tier (x90 bars + opening range):
 *   TIER_A: >= 5,000/bar  →  ~500K+ full-day volume (large caps, liquid)
 *   TIER_B: 1,500..5,000  →  ~135K..500K full-day (mid caps)
 *   TIER_C: 500..1,500    →  ~45K..135K full-day (small caps)
 *   TIER_D: < 500/bar     →  illiquid, avoid
 *
 * @param {number} avgPerBarVolume  — mean per-bar volume in the window
 * @returns {'TIER_A'|'TIER_B'|'TIER_C'|'TIER_D'|null}
 */
export function liquidityTier(avgPerBarVolume) {
  if (avgPerBarVolume == null || avgPerBarVolume <= 0) return null;
  if (avgPerBarVolume >= 5_000) return 'TIER_A';
  if (avgPerBarVolume >= 1_500) return 'TIER_B';
  if (avgPerBarVolume >= 500)   return 'TIER_C';
  return 'TIER_D';
}

/**
 * Blocks trading only on truly illiquid (TIER_D) stocks.
 * The sim already has a 25th-percentile volume filter earlier in the
 * pipeline, so this is a soft additional guard, not a hard veto.
 */
export function liquidityAllowsTrading(tier) {
  return tier !== 'TIER_D';
}

/**
 * Confidence adjustment for liquidity tier (small contributions only
 * — the sim's existing volume filter does most of the heavy lifting).
 */
export function liquidityConfidenceDelta(tier) {
  switch (tier) {
    case 'TIER_A': return +2;
    case 'TIER_B': return  0;
    case 'TIER_C': return -1;
    case 'TIER_D': return -15;
    default:       return  0;
  }
}

// ─── Layer 4: FII/DII institutional flow ───────────────────────────

/**
 * Classify institutional flow direction from FII and DII daily net buying.
 * Both in Rs crore. Signs: positive = net buy, negative = net sell.
 *
 * - STRONG_BUY  : both FII and DII positive, combined > Rs 500cr
 * - BUY         : either FII or DII positive, combined > 0
 * - NEUTRAL     : combined between -500cr and +500cr
 * - SELL        : combined < 0
 * - STRONG_SELL : both negative, combined < -Rs 500cr
 *
 * @param {number} fiiNet
 * @param {number} diiNet
 * @returns {'STRONG_BUY'|'BUY'|'NEUTRAL'|'SELL'|'STRONG_SELL'|null}
 */
export function classifyInstitutionalFlow(fiiNet, diiNet) {
  if (fiiNet == null || diiNet == null) return null;
  const combined = fiiNet + diiNet;
  if (fiiNet > 0 && diiNet > 0 && combined > 500)  return 'STRONG_BUY';
  if (combined > 0)                                return 'BUY';
  if (fiiNet < 0 && diiNet < 0 && combined < -500) return 'STRONG_SELL';
  if (combined < 0)                                return 'SELL';
  return 'NEUTRAL';
}

/**
 * FII/DII flow alignment with trade direction.
 * Institutional flow is a DAY-LEVEL bias — it doesn't say anything
 * about intraday moves, but the directional tilt is real.
 * @returns {+1 | 0 | -1}
 */
export function flowAlignment(flow, direction) {
  if (flow == null || flow === 'NEUTRAL') return 0;
  const isBullish = flow === 'BUY' || flow === 'STRONG_BUY';
  const isBearish = flow === 'SELL' || flow === 'STRONG_SELL';
  if (direction === 'long')  return isBullish ? +1 : isBearish ? -1 : 0;
  if (direction === 'short') return isBearish ? +1 : isBullish ? -1 : 0;
  return 0;
}

// ─── Layer 5: News / catalyst sentiment ─────────────────────────────

/**
 * Classify a news sentiment score (-1 to +1).
 * - BULLISH_STRONG : score > 0.5
 * - BULLISH        : 0.2..0.5
 * - NEUTRAL        : -0.2..0.2
 * - BEARISH        : -0.5..-0.2
 * - BEARISH_STRONG : score < -0.5
 *
 * @param {number} score
 * @returns {'BULLISH_STRONG'|'BULLISH'|'NEUTRAL'|'BEARISH'|'BEARISH_STRONG'|null}
 */
export function classifyNewsSentiment(score) {
  if (score == null || !Number.isFinite(score)) return null;
  if (score >  0.5) return 'BULLISH_STRONG';
  if (score >  0.2) return 'BULLISH';
  if (score >= -0.2) return 'NEUTRAL';
  if (score >= -0.5) return 'BEARISH';
  return 'BEARISH_STRONG';
}

/**
 * News alignment with trade direction — the strongest veto of the five
 * layers. A stock with BEARISH_STRONG news in the last 4 hours should
 * NEVER be long, period — the technicals are already reflecting the
 * news and any "momentum" is probably just the initial reaction still
 * playing out.
 * @returns {+1 | 0 | -1 | 'VETO'}
 */
export function newsAlignment(sentiment, direction) {
  if (sentiment == null || sentiment === 'NEUTRAL') return 0;
  const isBullish = sentiment === 'BULLISH' || sentiment === 'BULLISH_STRONG';
  const isBearish = sentiment === 'BEARISH' || sentiment === 'BEARISH_STRONG';
  // STRONG signals that conflict with direction are outright vetoes
  if (direction === 'long' && sentiment === 'BEARISH_STRONG') return 'VETO';
  if (direction === 'short' && sentiment === 'BULLISH_STRONG') return 'VETO';
  if (direction === 'long')  return isBullish ? +1 : isBearish ? -1 : 0;
  if (direction === 'short') return isBearish ? +1 : isBullish ? -1 : 0;
  return 0;
}

// ─── Composer: combine all layers into a single multi-factor score ──

/**
 * Combine all available market context signals into a single
 * "additional confidence" delta that the risk engine adds to the
 * base (technical-only) confidence score.
 *
 * Returns:
 *   { delta: number, veto: boolean, reasons: string[] }
 *
 *   delta  - signed confidence adjustment to add to base score
 *   veto   - true if any layer outright rejects the trade
 *   reasons - human-readable descriptions of each layer's contribution
 *
 * @param {Object} ctx
 * @param {'LOW'|'NORMAL'|'HIGH'|'PANIC'|null} ctx.vixRegime
 * @param {'GAP_UP_STRONG'|'GAP_UP'|'FLAT'|'GAP_DOWN'|'GAP_DOWN_STRONG'|null} ctx.gap
 * @param {'TIER_A'|'TIER_B'|'TIER_C'|'TIER_D'|null} ctx.liquidity
 * @param {'STRONG_BUY'|'BUY'|'NEUTRAL'|'SELL'|'STRONG_SELL'|null} ctx.flow
 * @param {'BULLISH_STRONG'|'BULLISH'|'NEUTRAL'|'BEARISH'|'BEARISH_STRONG'|null} ctx.sentiment
 * @param {'long'|'short'} direction
 */
export function composeContextScore(ctx, direction) {
  let delta = 0;
  let veto = false;
  const reasons = [];

  // Layer 1: VIX regime
  if (ctx.vixRegime) {
    const d = vixConfidenceDelta(ctx.vixRegime);
    delta += d;
    reasons.push(`VIX:${ctx.vixRegime}${d >= 0 ? '+' : ''}${d}`);
    if (!vixAllowsTrading(ctx.vixRegime)) veto = true;
  }

  // Design principle: layers can VETO trades (hard reject) or give a
  // positive confidence BOOST, but never apply a negative penalty.
  // Penalties shift candidate ranking — displacing high-quality winners
  // with moderately-penalized losers. Bonuses only affect the "should
  // this borderline trade clear the threshold?" question.

  // Design principle: VETO-ONLY. Zero positive bonuses — those shift
  // candidate ranking by promoting borderline setups over the threshold
  // and empirically hurt P&L in backtest (too many marginal trades).
  // Layers can ONLY reject a trade (hard veto) or be informational.
  // This keeps ranking identical to the technical-only baseline.
  //
  // Vetoes still matter a lot: VIX PANIC, TIER_D illiquidity, and
  // BEARISH_STRONG news on a long position are all real signals that
  // should block a trade outright. They don't change which trades
  // rank highest — they just remove bad ones from the list entirely.

  // Layer 2: Gap (informational only)
  if (ctx.gap) reasons.push(`gap:${ctx.gap}`);

  // Layer 3: Liquidity — veto TIER_D only
  if (ctx.liquidity) {
    if (!liquidityAllowsTrading(ctx.liquidity)) {
      veto = true;
      reasons.push(`liq:${ctx.liquidity}=VETO`);
    } else {
      reasons.push(`liq:${ctx.liquidity}`);
    }
  }

  // Layer 4: FII/DII flow (informational only in backtest)
  if (ctx.flow) reasons.push(`flow:${ctx.flow}`);

  // Layer 5: News sentiment — hard veto on counter-strong news only
  if (ctx.sentiment) {
    const align = newsAlignment(ctx.sentiment, direction);
    if (align === 'VETO') {
      veto = true;
      reasons.push(`news:${ctx.sentiment}=VETO`);
    } else {
      reasons.push(`news:${ctx.sentiment}`);
    }
  }

  return { delta, veto, reasons };
}
