import { isMarginEligible, MARGIN_PENALTY } from '../data/marginData.js';

/**
 * Risk / confidence score v2.
 * Fixes from adversarial review:
 *  - Entry includes 0.1% slippage buffer
 *  - SL: ATR-based only (removed 0.3% minimum)
 *  - Target: resistance-based with ATR fallback (removed median hack)
 *  - R:R scoring: continuous exponential (removed discrete buckets)
 *  - Confidence rescale: floor 30 (was 40)
 *  - Transaction cost filter: targetDist < 0.2% → NO TRADE
 *  - Time-of-day filter: first 15 min → -15 confidence
 *  - Volume-weighted signal clarity
 *  - Minimum volume gate: v < 5000 → NO TRADE
 *  - VWAP-proxy context detection
 *  - Support/resistance at 15%/85% (was 20%/80%)
 */

export const RISK_SIGNAL_DEFINITIONS = [
  { key: 'signalClarity', label: 'Signal clarity', max: 25, meaning: 'Pattern strength × volume factor × 25. Volume-confirmed patterns score higher.' },
  { key: 'lowNoise', label: 'Low noise (trend quality)', max: 20, meaning: 'ATR vs average body size; clean trends score higher.' },
  { key: 'riskReward', label: 'Risk : reward', max: 25, meaning: 'Continuous exponential scoring of R:R ratio. Higher R:R earns more points.' },
  { key: 'patternReliability', label: 'Pattern reliability', max: 15, meaning: 'Built-in reliability of the top pattern × 15.' },
  { key: 'confluence', label: 'Confluence', max: 15, meaning: 'Volume spike, SMA alignment, context, VWAP-proxy, box signal. Capped at 15.' },
];

function sma(vals, n) {
  if (!vals.length || n < 1) return null;
  const slice = vals.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function atrLike(candles, n = 14) {
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

/** VWAP-like proxy: volume-weighted typical price over last N bars. */
function vwapProxy(candles, n = 20) {
  const slice = candles.slice(-n);
  let sumPV = 0, sumV = 0;
  for (const c of slice) {
    const tp = (c.h + c.l + c.c) / 3;
    const v = c.v || 1;
    sumPV += tp * v;
    sumV += v;
  }
  return sumV > 0 ? sumPV / sumV : null;
}

/**
 * Context detection v2.
 * - Support/resistance at 15%/85% quantile (was 20%/80%)
 * - VWAP-proxy integration
 */
export function detectContext(candles, box) {
  if (!candles || candles.length < 5) return 'mid_range';

  const cur = candles[candles.length - 1];
  const window = candles.slice(-20);
  const hi20 = Math.max(...window.map(c => c.h));
  const lo20 = Math.min(...window.map(c => c.l));
  const range20 = hi20 - lo20 || 1;

  if (box) {
    if (cur.c > box.high) return 'breakout';
    if (cur.c < box.low) return 'breakout';
  }

  const pct = (cur.c - lo20) / range20;
  if (pct <= 0.15) return 'at_support';
  if (pct >= 0.85) return 'at_resistance';
  return 'mid_range';
}

/**
 * @param {object} params
 * @param {Array} params.candles
 * @param {Array} params.patterns
 * @param {object|null} params.box
 * @param {{ barIndex?: number }} [params.opts] — barIndex for time-of-day filter
 */
export function computeRiskScore({ candles, patterns, box, opts }) {
  const top = patterns?.length ? patterns[0] : null;
  const cur = candles[candles.length - 1];
  const barIndex = opts?.barIndex ?? candles.length;

  // Volume gate: if current volume < 5000, force NO TRADE
  if ((cur.v || 0) < 5000) {
    return noTrade(cur, candles, box);
  }

  /* ── 1. Signal clarity (max 25) — volume-weighted ──────────── */
  const vols = candles.slice(-11, -1).map(c => c.v || 0);
  const avgV = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 1;
  const volFactor = avgV > 0 ? Math.min(2, (cur.v || 0) / avgV) : 1;
  const signalClarity = top ? Math.min(25, top.strength * volFactor * 25) : 2;

  /* ── 2. Low noise / trend quality (max 20) ─────────────────── */
  const bodies = candles.slice(-6, -1).map(c => Math.abs(c.c - c.o));
  const avgBody = bodies.reduce((a, b) => a + b, 0) / Math.max(bodies.length, 1) || 1;
  const atr10 = atrLike(candles, 10);
  const chop = Math.min(1, atr10 / (avgBody * 3));
  const lowNoise = (1 - chop) * 20;

  /* ── 3. Risk:Reward (max 25) — ATR-based, no 0.3% minimum ─── */
  const direction = top?.direction === 'bearish' ? 'short' : top?.direction === 'bullish' ? 'long' : 'long';
  const atrVal = atrLike(candles, 14);

  // FIX: entry includes slippage buffer
  const rawEntry = cur.c;
  const entry = direction === 'long' ? rawEntry * 1.001 : rawEntry * 0.999;

  // SL: ATR-based, widened to 2.0x to avoid stop-hunting
  const slDist = atrVal * 2.0;
  let sl, target, targetDist;

  if (direction === 'long') {
    sl = entry - slDist;
    const resistance = Math.max(...candles.slice(-20).map(c => c.h));
    const resistanceDist = resistance - entry;
    // FIX: use resistance if valid, otherwise ATR fallback (no median hack)
    targetDist = resistanceDist > slDist * 0.5 ? resistanceDist : atrVal * 3.0;
    target = entry + targetDist;
  } else {
    sl = entry + slDist;
    const support = Math.min(...candles.slice(-20).map(c => c.l));
    const supportDist = entry - support;
    targetDist = supportDist > slDist * 0.5 ? supportDist : atrVal * 3.0;
    target = entry - targetDist;
  }

  const rr = targetDist / Math.max(slDist, 1e-9);
  const rrClamped = Math.min(5, Math.max(0.3, rr));

  // FIX: continuous exponential scoring (no more discrete buckets)
  const rrScore = Math.round(25 * (1 - Math.exp(-0.7 * rrClamped)));

  // Transaction cost filter — if target < 0.2% of entry, not worth trading
  if (targetDist < entry * 0.002) {
    return noTrade(cur, candles, box);
  }

  // Minimum R:R filter — don't take trades below 1.5:1
  if (rr < 1.5) {
    return noTrade(cur, candles, box);
  }

  /* ── 4. Pattern reliability (max 15) ───────────────────────── */
  const patternRel = top ? top.reliability * 15 : 3;

  /* ── 5. Confluence (max 15) ────────────────────────────────── */
  let confluence = 0;

  // Volume spike
  if (avgV > 0 && cur.v > avgV * 2) confluence += 5;
  else if (avgV > 0 && cur.v > avgV * 1.3) confluence += 3;

  // Volume trend
  if (candles.length >= 4) {
    const last3 = candles.slice(-3);
    const volUp = last3[0].v < last3[1].v && last3[1].v < last3[2].v;
    const priceUp = last3[2].c > last3[0].c;
    const priceDown = last3[2].c < last3[0].c;
    if (volUp && ((direction === 'long' && priceUp) || (direction === 'short' && priceDown))) confluence += 3;
    const volDown = last3[0].v > last3[1].v && last3[1].v > last3[2].v;
    if (volDown && ((direction === 'long' && priceDown) || (direction === 'short' && priceUp))) confluence -= 2;
  }

  // SMA alignment — strong trend-direction filter
  const closes = candles.map(c => c.c);
  const s10 = sma(closes, 10);
  const s20 = sma(closes, 20);
  if (s10 != null && s20 != null) {
    if (top?.direction === 'bullish' && s10 > s20) confluence += 5;
    if (top?.direction === 'bearish' && s10 < s20) confluence += 5;
  }

  // VWAP-proxy alignment (new in v2)
  const vwap = vwapProxy(candles, 20);
  if (vwap != null) {
    if (direction === 'long' && cur.c > vwap) confluence += 2;
    else if (direction === 'short' && cur.c < vwap) confluence += 2;
    else if (direction === 'long' && cur.c < vwap) confluence -= 2;
    else if (direction === 'short' && cur.c > vwap) confluence -= 2;
  }

  // Context alignment
  const context = detectContext(candles, box);
  if (top?.direction === 'bullish' && context === 'at_support') confluence += 4;
  else if (top?.direction === 'bearish' && context === 'at_resistance') confluence += 4;
  else if (top?.direction === 'bullish' && context === 'at_resistance') confluence -= 3;
  else if (top?.direction === 'bearish' && context === 'at_support') confluence -= 3;
  else if (context === 'breakout') confluence += 3;

  // Box breakout / trap
  if (box) {
    const bq = box.quality || 0;
    const bs = box.breakoutStrength || 0;
    const td = box.trapDepth || 0;
    if (box.breakout !== 'none') confluence += Math.round(2 + bq * 2 + bs * 1);
    else if (box.trap !== 'none' && td > 0.2) confluence += Math.round(1 + bq * 2 + td * 1);
  }

  confluence = Math.max(0, confluence);

  /* ── Raw → Confidence ──────────────────────────────────────── */
  const raw = signalClarity + lowNoise + rrScore + patternRel + Math.min(15, confluence);
  const rawClamped = Math.min(100, Math.round(raw));

  // FIX: rescale floor 30 (was 40)
  let confidence = Math.round(30 + (rawClamped / 100) * 70);

  // FIX: time-of-day penalty — first 15 min (3 bars on 5m) = -15 confidence
  if (barIndex < 3) confidence = Math.max(30, confidence - 15);

  // Margin eligibility penalty
  if (opts?.margin && opts?.sym && !isMarginEligible(opts.sym, opts.marginMap)) {
    confidence += MARGIN_PENALTY;
    confidence = Math.max(30, Math.min(100, confidence));
  }

  const breakdown = {
    signalClarity: Math.round(signalClarity),
    lowNoise: Math.round(lowNoise),
    riskReward: rrScore,
    patternReliability: Math.round(patternRel),
    confluence: Math.min(15, Math.round(Math.max(0, confluence))),
  };

  let level = 'low';
  if (confidence >= 70) level = 'high';
  else if (confidence >= 55) level = 'moderate';

  let action = 'NO TRADE';
  if (confidence >= 72 && top && top.direction !== 'neutral') {
    action = top.direction === 'bearish' ? 'STRONG SHORT' : 'STRONG BUY';
  } else if (confidence >= 58 && top && top.direction !== 'neutral') {
    action = top.direction === 'bearish' ? 'SHORT' : 'BUY';
  } else if (confidence >= 45 && top) {
    action = 'WAIT';
  }

  // Signal fired on current bar; entry window is ~2 bars = 10 min on 5m
  const signalBarTs = cur.t || null;
  const validTillTs = signalBarTs ? signalBarTs + 10 * 60 : null;

  return { total: rawClamped, confidence, breakdown, level, action, entry, sl, target, rr: rrClamped, direction, context, signalBarTs, validTillTs };
}

/** Helper: returns a NO TRADE result with context info */
function noTrade(cur, candles, box) {
  const context = detectContext(candles, box);
  return {
    total: 0, confidence: 30, breakdown: { signalClarity: 0, lowNoise: 0, riskReward: 0, patternReliability: 0, confluence: 0 },
    level: 'low', action: 'NO TRADE',
    entry: cur.c, sl: cur.c, target: cur.c, rr: 0, direction: 'long', context,
    signalBarTs: cur.t || null, validTillTs: null,
  };
}
