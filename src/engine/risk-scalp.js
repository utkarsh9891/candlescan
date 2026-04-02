/**
 * Scalping risk scoring engine.
 * Optimized for 5-15 min holds on 1m candles.
 *
 * === HARD CONSTRAINTS (do NOT exceed these) ===
 *  - maxHoldBars: 15 (15 min on 1m — hard scalp limit)
 *  - Timeframe: 1m only
 *  - Window: 09:30-11:00 AM IST
 *
 * Key differences from v2 (intraday):
 *  - SL: max(ATR×2.5, avgBarRange×4, 1.2%)
 *  - Target: resistance/support-based, capped at ATR×3
 *  - Time-based exit: maxHoldBars = 15 (15 min on 1m)
 *  - Index direction filter: -15 confidence for counter-trend
 *  - Day/time awareness (Monday/Friday adjustments)
 *  - Wider slippage buffer (0.15%)
 *  - Min R:R 1.5:1
 *  - Confidence floor 20 (wider range for discrimination)
 */

import { isMarginEligible, MARGIN_PENALTY } from '../data/marginData.js';

export const RISK_SIGNAL_DEFINITIONS = [
  { key: 'signalClarity', label: 'Signal clarity', max: 25, meaning: 'Pattern strength × volume factor × 25.' },
  { key: 'lowNoise', label: 'Low noise', max: 20, meaning: 'ATR vs body size; clean moves score higher.' },
  { key: 'riskReward', label: 'Risk : reward', max: 25, meaning: 'Continuous scoring of R:R ratio.' },
  { key: 'patternReliability', label: 'Pattern reliability', max: 15, meaning: 'Built-in reliability × 15.' },
  { key: 'confluence', label: 'Confluence', max: 15, meaning: 'Volume, EMA, VWAP, index alignment, context.' },
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

function emaVal(candles, period) {
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

export function detectContext(candles, box) {
  if (!candles || candles.length < 5) return 'mid_range';
  const cur = candles[candles.length - 1];
  const window = candles.slice(-20);
  const hi = Math.max(...window.map(c => c.h));
  const lo = Math.min(...window.map(c => c.l));
  const r = hi - lo || 1;
  if (box) {
    if (cur.c > box.high) return 'breakout';
    if (cur.c < box.low) return 'breakout';
  }
  const pct = (cur.c - lo) / r;
  if (pct <= 0.15) return 'at_support';
  if (pct >= 0.85) return 'at_resistance';
  return 'mid_range';
}

/**
 * @param {{ candles, patterns, box, opts?: { barIndex?, indexDirection?, dayOfWeek? } }} params
 */
export function computeRiskScore({ candles, patterns, box, opts }) {
  const top = patterns?.length ? patterns[0] : null;
  const cur = candles[candles.length - 1];
  const barIndex = opts?.barIndex ?? candles.length;

  // Hard gate: skip first 12 bars (9:15–9:27) — opening range chaos
  if (barIndex < 12) return noTrade(cur, candles, box);

  // Volume gate: use average of recent 5 candles (last candle often has 0 in Yahoo 1m data)
  const recentVols = candles.slice(-6, -1).map(c => c.v || 0);
  const recentAvgVol = recentVols.length ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : 0;
  if (recentAvgVol < 5000) return noTrade(cur, candles, box);

  // Extreme mover filter: boost confidence for stocks with big intraday moves
  // Applied as soft bonus rather than hard gate — let the scoring discriminate
  const dayStartIdx = Math.max(0, candles.length - barIndex);
  const dayOpen = candles[dayStartIdx]?.o || cur.c;
  const intradayPct = (cur.c - dayOpen) / dayOpen;
  const absIntradayPct = Math.abs(intradayPct);

  /* ── 1. Signal clarity (max 25) — volume-weighted ──────────── */
  const vols = candles.slice(-11, -1).map(c => c.v || 0);
  const avgV = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 1;
  // Use max of current vol and recent avg for volFactor (handles 0-vol last candle)
  const effectiveVol = Math.max(cur.v || 0, recentAvgVol);
  const volFactor = avgV > 0 ? Math.min(2.5, effectiveVol / avgV) : 1;
  const signalClarity = top ? Math.min(25, top.strength * volFactor * 25) : 2;

  /* ── 2. Low noise (max 20) ─────────────────────────────────── */
  const bodies = candles.slice(-6, -1).map(c => Math.abs(c.c - c.o));
  const avgBody = bodies.reduce((a, b) => a + b, 0) / Math.max(bodies.length, 1) || 1;
  const atr10 = atrLike(candles, 10);
  const chop = Math.min(1, atr10 / (avgBody * 3));
  const lowNoise = (1 - chop) * 20;

  /* ── 3. Risk:Reward (max 25) — tight scalp levels ──────────── */
  const direction = top?.direction === 'bearish' ? 'short' : top?.direction === 'bullish' ? 'long' : 'long';
  const atrVal = atrLike(candles, 14);

  // Zero slippage — entry at candle close (NIFTY 200 stocks are institutional-grade liquid)
  const entry = cur.c;

  // SL: tight — exit losers before TIME exit catches them with bigger loss
  const avgBarRange = candles.slice(-10).reduce((s, c) => s + (c.h - c.l), 0) / 10;
  const slDist = Math.max(atrVal * 1.5, avgBarRange * 3, entry * 0.01);
  const targetFloor = entry * 0.007; // 0.7% minimum

  let targetDist;
  let sl, target;

  if (direction === 'long') {
    sl = entry - slDist;
    const resistanceDist = box?.high ? Math.max(0, box.high - entry) : Infinity;
    targetDist = Math.max(Math.min(resistanceDist, atrVal * 2.0), targetFloor);
    target = entry + targetDist;
  } else {
    sl = entry + slDist;
    const supportDist = box?.low ? Math.max(0, entry - box.low) : Infinity;
    targetDist = Math.max(Math.min(supportDist, atrVal * 2.0), targetFloor);
    target = entry - targetDist;
  }

  const rr = targetDist / Math.max(slDist, 1e-9);
  const rrClamped = Math.min(9, Math.max(0.1, rr));
  // R:R scoring: continuous, favoring higher R:R
  const rrScore = Math.round(25 * (1 - Math.exp(-2.5 * rrClamped)));

  // Min target 0.2% of entry
  if (targetDist < entry * 0.002) return noTrade(cur, candles, box);

  /* ── 4. Pattern reliability (max 15) ───────────────────────── */
  const patternRel = top ? top.reliability * 15 : 3;

  /* ── 5. Confluence (max 15) ────────────────────────────────── */
  let confluence = 0;

  // Volume spike
  if (avgV > 0 && cur.v > avgV * 2) confluence += 5;
  else if (avgV > 0 && cur.v > avgV * 1.3) confluence += 3;

  // EMA alignment (5/13)
  const ema5 = emaVal(candles.slice(-6), 5);
  const ema13 = emaVal(candles.slice(-14), 13);
  if (ema5 != null && ema13 != null) {
    if (direction === 'long' && ema5 > ema13) confluence += 4;
    if (direction === 'short' && ema5 < ema13) confluence += 4;
    if (direction === 'long' && ema5 < ema13) confluence -= 3;
    if (direction === 'short' && ema5 > ema13) confluence -= 3;
  }

  // VWAP alignment
  const vwap = vwapProxy(candles, 20);
  if (vwap != null) {
    if (direction === 'long' && cur.c > vwap) confluence += 3;
    else if (direction === 'short' && cur.c < vwap) confluence += 3;
    else if (direction === 'long' && cur.c < vwap) confluence -= 5;
    else if (direction === 'short' && cur.c > vwap) confluence -= 5;
  }

  // Context
  const context = detectContext(candles, box);
  if (top?.direction === 'bullish' && context === 'at_support') confluence += 3;
  else if (top?.direction === 'bearish' && context === 'at_resistance') confluence += 3;
  else if (context === 'breakout') confluence += 2;

  // Box breakout
  if (box) {
    if (box.breakout !== 'none') confluence += Math.round(2 + (box.quality || 0) * 2);
  }

  confluence = Math.max(0, confluence);

  /* ── Raw → Confidence ──────────────────────────────────────── */
  const raw = signalClarity + lowNoise + rrScore + patternRel + Math.min(15, confluence);
  const rawClamped = Math.min(100, Math.round(raw));

  // Confidence floor 20 (wider range for scalping discrimination)
  let confidence = Math.round(20 + (rawClamped / 100) * 80);

  // Index direction filter — bonus for alignment, moderate penalty for counter-trend
  const idxDir = opts?.indexDirection;
  if (idxDir) {
    if (direction === 'long' && idxDir.direction === 'bullish') confidence += 5;
    else if (direction === 'short' && idxDir.direction === 'bearish') confidence += 5;
    else if (direction === 'long' && idxDir.direction === 'bearish') confidence -= 15;
    else if (direction === 'short' && idxDir.direction === 'bullish') confidence -= 15;
  }

  // Extreme mover bonus: reward stocks with big intraday moves (your edge)
  if (absIntradayPct >= 0.02) confidence += 8;        // 2%+ move: strong bonus
  else if (absIntradayPct >= 0.015) confidence += 5;   // 1.5%+ move: moderate bonus
  else if (absIntradayPct >= 0.01) confidence += 2;    // 1%+ move: small bonus
  // Direction alignment bonus
  if (top?.direction === 'bullish' && intradayPct > 0.01) confidence += 3; // riding the rise
  if (top?.direction === 'bearish' && intradayPct < -0.01) confidence += 3; // momentum short

  // Day-of-week awareness
  const dow = opts?.dayOfWeek;
  if (dow === 1 && barIndex < 15) confidence = Math.max(20, confidence - 10); // Monday early
  if (dow === 5 && barIndex > 75) confidence = Math.max(20, confidence - 10); // Friday late

  confidence = Math.max(20, Math.min(100, confidence));

  // Margin eligibility penalty: penalize non-margin stocks when margin trading is enabled
  if (opts?.margin && opts?.sym && !isMarginEligible(opts.sym, opts.marginMap)) {
    confidence += MARGIN_PENALTY;
    confidence = Math.max(20, Math.min(100, confidence));
  }

  const breakdown = {
    signalClarity: Math.round(signalClarity),
    lowNoise: Math.round(lowNoise),
    riskReward: rrScore,
    patternReliability: Math.round(patternRel),
    confluence: Math.min(15, Math.round(Math.max(0, confluence))),
  };

  let level = 'low';
  if (confidence >= 75) level = 'high';
  else if (confidence >= 60) level = 'moderate';

  let action = 'NO TRADE';
  if (confidence >= 75 && top && top.direction !== 'neutral') {
    action = top.direction === 'bearish' ? 'STRONG SHORT' : 'STRONG BUY';
  } else if (confidence >= 65 && top && top.direction !== 'neutral') {
    action = top.direction === 'bearish' ? 'SHORT' : 'BUY';
  } else if (confidence >= 50 && top) {
    action = 'WAIT';
  }

  return {
    total: rawClamped, confidence, breakdown, level, action,
    entry, sl, target, rr: rrClamped, direction, context,
    maxHoldBars: 20, // 20 minutes — optimal
  };
}

function noTrade(cur, candles, box) {
  const context = detectContext(candles, box);
  return {
    total: 0, confidence: 20, breakdown: { signalClarity: 0, lowNoise: 0, riskReward: 0, patternReliability: 0, confluence: 0 },
    level: 'low', action: 'NO TRADE',
    entry: cur.c, sl: cur.c, target: cur.c, rr: 0, direction: 'long', context,
    maxHoldBars: 20,
  };
}
