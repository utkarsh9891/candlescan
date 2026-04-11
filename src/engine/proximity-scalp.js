/**
 * Proximity detector for the Strong Momo Pullback pattern.
 *
 * Companion to `patterns-scalp.js`. Where that module is a strict binary
 * "fire or don't fire" gate, this one runs the SAME criteria with relaxed
 * thresholds and returns a 0..1 proximity score — a measure of how close
 * a stock is to firing the real pattern.
 *
 * The Novice Mode watch list uses this to answer the question:
 *   "This stock isn't a BUY right now, but is it worth checking again
 *    in a couple of minutes?"
 *
 * Design principles:
 *
 *  1. Same *structural* gates as the real pattern — just relaxed.
 *     If the pattern requires stockIntraPct >= 1.5%, proximity accepts
 *     >= 0.8% and scores linearly in between. Nothing new, just a
 *     softer version of the same shape.
 *
 *  2. Hard constraints stay hard. A stock moving the wrong way relative
 *     to the index, or with EMA5 below EMA13 for a long setup, is NOT
 *     a watch-list candidate no matter how close other metrics look.
 *     Scalping on the wrong side of trend isn't "almost right", it's
 *     wrong.
 *
 *  3. This is NOT a new trading pattern. It never gates trades. The
 *     risk engine and the pattern detector are untouched. Proximity
 *     only feeds the UI — "check back soon".
 *
 *  4. Cheap to compute. Runs the same ema/vwap/volFactor helpers as
 *     the real detector so the watch-list auto-refresher can re-score
 *     a handful of stocks every ~60s without concern.
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

function volFactorCalc(candles) {
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
 * Linear score from `worst` (=> 0) to `best` (=> 1). Values outside
 * the range clamp. Direction of improvement is determined by which of
 * worst/best is larger.
 */
function lerp(value, worst, best) {
  if (worst === best) return value >= best ? 1 : 0;
  const t = (value - worst) / (best - worst);
  return Math.max(0, Math.min(1, t));
}

/**
 * Format a proximity component as a short tag for UI display.
 * Shows the metric with its current value vs the fire threshold.
 */
function tag(label, value, unit = '') {
  if (typeof value !== 'number' || !isFinite(value)) return label;
  const sign = value > 0 ? '+' : '';
  return `${label} ${sign}${value.toFixed(unit === '%' ? 2 : 1)}${unit}`;
}

/**
 * @param {Array} candles — full candle array
 * @param {{
 *   barIndex?: number,
 *   indexDirection?: { direction, strength, intradayPct?, preWindowMove? },
 *   stockDayOpen?: number,
 * }} [opts]
 * @returns {null | {
 *   direction: 'long' | 'short',
 *   proximity: number,    // 0..1, where ~0.95 means "almost firing"
 *   stockIntraPct: number,
 *   rs: number,
 *   pullbackPct: number,
 *   volFactor: number,
 *   missing: string[],    // plain-english list of what's not yet at fire level
 *   present: string[],    // plain-english list of what IS at fire level
 *   hint: string,         // one-line summary the novice UI can show
 * }}
 */
export function detectProximity(candles, opts) {
  if (!candles?.length || candles.length < 20) return null;

  const n = candles.length;
  const cur = candles[n - 1];
  const prev = candles[n - 2];
  const barIndex = opts?.barIndex ?? n;

  // Hard constraint: need an index direction read. Proximity on a chop
  // day is meaningless — the pattern itself rejects chop.
  const idxDir = opts?.indexDirection || null;
  if (!idxDir || idxDir.preWindowMove == null) return null;

  // Hard constraint: must be within the effective trading window.
  // Pattern fires up to barIndex 45 (9:30..10:15). We'll be a little
  // more generous for the watch list (up to 60 = 10:30) because a
  // stock that's still forming at 10:20 is worth flagging for a
  // 10:22-10:28 entry.
  if (barIndex > 60) return null;

  // VWAP anchor
  const vwap = vwapProxy(candles, 20);
  if (vwap == null) return null;
  const pullbackPct = Math.abs(cur.c - vwap) / vwap;

  // Trend filters
  const ema5 = ema(candles.slice(-6), 5);
  const ema13 = ema(candles.slice(-14), 13);
  if (ema5 == null || ema13 == null) return null;

  // Volume factor
  const vf = volFactorCalc(candles);

  // Day-open for intraday % calc
  const dayOpen = opts?.stockDayOpen != null
    ? opts.stockDayOpen
    : (candles[Math.max(0, n - barIndex - 15)]?.o || cur.c);
  const stockIntraPct = (cur.c - dayOpen) / dayOpen;
  const idxIntraPct = idxDir.intradayPct ?? 0;

  // Session extremes (used for the "not chasing top/bottom" soft gate)
  const sessionLen = Math.max(1, barIndex + 15);
  const session = candles.slice(-sessionLen);
  const sessionHigh = Math.max(...session.map(c => c.h));
  const sessionLow = Math.min(...session.map(c => c.l));

  // ── Direction selection ────────────────────────────────────────
  // A stock is a LONG watch candidate only if the index is trending
  // up (pre-window move > +0.1%) AND the stock is in an uptrend
  // (EMA5 > EMA13) AND already up on the day (>= +0.5%).
  // SHORT mirrors everything.
  const longPossible =
    idxDir.preWindowMove > 0.001 &&
    ema5 > ema13 &&
    stockIntraPct >= 0.005 &&
    cur.c > vwap;

  const shortPossible =
    idxDir.preWindowMove < -0.001 &&
    ema5 < ema13 &&
    stockIntraPct <= -0.005 &&
    cur.c < vwap;

  if (!longPossible && !shortPossible) return null;

  const direction = longPossible ? 'long' : 'short';

  // ── Scoring — each component 0..1, weighted sum → proximity ─────
  //
  // Weights chosen so that the two hardest-to-satisfy criteria of
  // the real pattern (stockIntraPct and RS vs index) dominate — a
  // stock that's already up 1.4% with RS 0.75% is clearly "close"
  // even if the pullback is loose and vol is lukewarm. Weights sum
  // to 1.0.

  // 1. Intraday move magnitude (0..1)
  const moveMag = Math.abs(stockIntraPct);
  // For the fire gate: 1.5%. Watch list starts valuing the stock at
  // 0.5% and saturates at 1.5%.
  const moveScore = lerp(moveMag, 0.005, 0.015);

  // 2. Relative strength (same sign as direction)
  const rs = direction === 'long'
    ? stockIntraPct - idxIntraPct
    : idxIntraPct - stockIntraPct;
  // Fire gate: 0.8%. Watch list starts at 0.2% and saturates at 0.8%.
  const rsScore = lerp(rs, 0.002, 0.008);

  // 3. Pullback tightness — smaller is better
  // Fire gate: 0.3%. Watch list: 0.8% → score 0, 0.1% → score 1.
  const pullbackScore = lerp(pullbackPct, 0.008, 0.001);

  // 4. Volume factor
  // Fire gate: 1.5x. Watch list: 1.0x → 0, 1.5x → 1.
  const volScore = lerp(vf, 1.0, 1.5);

  // 5. Candle direction alignment (bonus/penalty)
  // A bullish bar for a long setup gets full credit, flat gets 0.5,
  // a down-ticking bar gets 0. Same idea, mirrored, for shorts.
  let candleScore;
  if (direction === 'long') {
    if (cur.c > cur.o && cur.c > prev.c) candleScore = 1;
    else if (cur.c >= cur.o) candleScore = 0.5;
    else candleScore = 0.2;
  } else {
    if (cur.c < cur.o && cur.c < prev.c) candleScore = 1;
    else if (cur.c <= cur.o) candleScore = 0.5;
    else candleScore = 0.2;
  }

  // Weighted composition
  const proximity =
    moveScore * 0.30 +
    rsScore * 0.30 +
    pullbackScore * 0.15 +
    volScore * 0.15 +
    candleScore * 0.10;

  // Not chasing the session extreme — soft gate, penalty if violated
  let extremePenalty = 0;
  if (direction === 'long' && cur.c >= sessionHigh * 0.998) extremePenalty = 0.2;
  if (direction === 'short' && cur.c <= sessionLow * 1.002) extremePenalty = 0.2;

  const finalProximity = Math.max(0, Math.min(1, proximity - extremePenalty));

  // ── Build plain-english hints ──────────────────────────────────
  // "missing" lists are what the novice UI shows under "still
  // needs..." so the user can develop an intuition for what the
  // engine is looking for. No jargon.
  const missing = [];
  const present = [];

  if (moveScore >= 0.9) present.push('strong move');
  else if (moveScore >= 0.5) missing.push('needs a bit more move');
  else missing.push('not moved enough yet');

  if (rsScore >= 0.9) present.push('beating the market');
  else if (rsScore >= 0.5) missing.push('slightly beating the market');
  else missing.push('not outperforming market yet');

  if (pullbackScore >= 0.9) present.push('tight pullback');
  else if (pullbackScore >= 0.5) missing.push('pullback too loose');
  else missing.push('price drifted away');

  if (volScore >= 0.9) present.push('strong volume');
  else if (volScore >= 0.5) missing.push('volume picking up');
  else missing.push('volume weak');

  // One-line hint shows the most-relevant status
  let hint;
  if (finalProximity >= 0.85) {
    hint = direction === 'long'
      ? 'Close to firing a BUY — check in a minute'
      : 'Close to firing a SHORT — check in a minute';
  } else if (finalProximity >= 0.6) {
    hint = direction === 'long'
      ? 'Building a long setup — watch it'
      : 'Building a short setup — watch it';
  } else if (finalProximity >= 0.4) {
    hint = direction === 'long'
      ? 'Early long setup — may take a few minutes'
      : 'Early short setup — may take a few minutes';
  } else {
    hint = 'Still forming — check later';
  }

  return {
    direction,
    proximity: finalProximity,
    stockIntraPct,
    rs,
    pullbackPct,
    volFactor: vf,
    missing,
    present,
    hint,
    // Tags useful for debug / advanced-mode display
    tags: [
      tag('move', stockIntraPct * 100, '%'),
      tag('rs', rs * 100, '%'),
      tag('pullback', pullbackPct * 100, '%'),
      `vol ${vf.toFixed(1)}x`,
    ],
  };
}

/**
 * Proximity tier thresholds. Used by the UI to decide how to present
 * a watch-list candidate (copy, color, placement).
 */
export const PROXIMITY_TIERS = {
  IMMINENT: 0.85,   // "Check in a minute"
  BUILDING: 0.60,   // "Watch it"
  EARLY:    0.40,   // "May take a few minutes"
};

/**
 * Classify a result row (batchScan output) into a novice-mode category
 * using confidence + proximity together.
 *
 * Returns one of:
 *   'trade-now' — actionable, take the trade (confidence >= 75, not gated)
 *   'imminent'  — not yet actionable but very close (confidence 60-74 OR proximity >= 0.85)
 *   'building'  — forming up (proximity 0.6..0.85)
 *   'early'     — early hints (proximity 0.4..0.6)
 *   'ignore'    — not interesting for the novice surface
 */
export function classifyForNovice(result, proximity) {
  if (!result) return 'ignore';
  const action = result.action;
  const confidence = result.confidence ?? 0;

  // Gated results (regime gate rejected) never surface as trade-now
  const gated = !!result.gatedReason;

  if (!gated && (action === 'STRONG BUY' || action === 'BUY' ||
                 action === 'STRONG SHORT' || action === 'SHORT')) {
    return 'trade-now';
  }

  const prox = proximity?.proximity ?? 0;
  if (confidence >= 60 || prox >= PROXIMITY_TIERS.IMMINENT) return 'imminent';
  if (prox >= PROXIMITY_TIERS.BUILDING) return 'building';
  if (prox >= PROXIMITY_TIERS.EARLY) return 'early';
  return 'ignore';
}
