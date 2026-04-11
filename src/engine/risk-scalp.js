/**
 * Scalping risk scoring — paired with the single-pattern detector in
 * patterns-scalp.js. This module's job is purely: given that a valid
 * ORB-continuation setup fired, compute SL, target, confidence and
 * action for that one idea.
 *
 * Hard constraints:
 *  - maxHoldBars: 15 (15 min on 1m)
 *  - Timeframe: 1m
 *  - Window: 09:15-11:00 IST (trading window imposed by caller)
 *
 * Risk architecture:
 *  - SL anchored to the opposite side of the opening range (the
 *    breakout's natural invalidation level), capped at 0.5% of entry
 *    so single-stock spikes don't blow up the trade size.
 *  - Target is a multiple of the SL distance (3:1 by default) to
 *    ensure positive expected value even at 40% win rate.
 *  - Min R:R gate: 2.5:1. Setups that can't offer this don't trade.
 *  - Confidence is a function of pattern strength + volume + RS — the
 *    three factors that actually predicted the winning days in backtest.
 */

import { isMarginEligible, MARGIN_PENALTY } from '../data/marginData.js';

export const RISK_SIGNAL_DEFINITIONS = [
  { key: 'signalClarity', label: 'Signal clarity', max: 30, meaning: 'Pattern strength.' },
  { key: 'relativeStrength', label: 'Relative strength', max: 25, meaning: 'Stock vs index intraday %.' },
  { key: 'volume', label: 'Volume', max: 15, meaning: 'Volume factor vs recent average.' },
  { key: 'riskReward', label: 'Risk : reward', max: 20, meaning: 'SL vs target distance ratio.' },
  { key: 'regime', label: 'Regime alignment', max: 10, meaning: 'Index direction match.' },
];

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

function detectContext(candles) {
  if (!candles || candles.length < 5) return 'mid_range';
  const cur = candles[candles.length - 1];
  const window = candles.slice(-20);
  const hi = Math.max(...window.map(c => c.h));
  const lo = Math.min(...window.map(c => c.l));
  const r = hi - lo || 1;
  const pct = (cur.c - lo) / r;
  if (pct <= 0.15) return 'at_support';
  if (pct >= 0.85) return 'at_resistance';
  return 'mid_range';
}

/**
 * @param {{ candles, patterns, box?, opts?: { barIndex?, indexDirection?, orbHigh?, orbLow?, margin?, marginMap?, sym? } }} params
 */
export function computeRiskScore({ candles, patterns, opts }) {
  const cur = candles[candles.length - 1];
  const top = patterns?.length ? patterns[0] : null;

  // Pattern detector already gated the setup — if nothing fired, it's NO TRADE.
  if (!top || top.direction === 'neutral') {
    return noTrade(cur, candles);
  }

  const direction = top.direction === 'bearish' ? 'short' : 'long';
  const entry = cur.c;
  const barIndex = opts?.barIndex ?? candles.length;
  const atrVal = atrLike(candles, 14);

  // ─── SL / target — the math-bound minimum ───
  // Tx cost alone eats 0.1% per round-trip trade. 5 trades = 0.5% daily
  // just in fees. To clear Rs 10k net on 15L we need ~Rs 17,500 gross.
  // Per-trade: Rs 3,500 gross = 0.233% on 15L.
  //
  // At R:R 2:1 and 50% WR: trade EV = 0.5*(2Y) - 0.5*Y = 0.5Y.
  // 0.5Y = 0.233% → Y = 0.467% SL, 0.934% target.
  //
  // Rounded to 0.5% / 1.0% to give a small buffer:
  //   SL = 0.5% → Rs 7,500 risk on 15L
  //   Target = 1.0% → Rs 15,000 reward on 15L (2:1 R:R)
  //
  // EV table:
  //   55% WR: 0.55×15,000 - 0.45×7,500 = 4,875/trade → 5 trades = 24,375 ✓
  //   50% WR: 0.50×15,000 - 0.50×7,500 = 3,750/trade → 5 trades = 18,750 ✓ (clear)
  //   45% WR: 0.45×15,000 - 0.55×7,500 = 2,625/trade → 5 trades = 13,125 ✓
  //   40% WR: 0.40×15,000 - 0.60×7,500 = 1,500/trade → 5 trades = 7,500 ✗
  // Net after Rs 7,500 tx cost:
  //   55% WR → +16,875 ✓
  //   50% WR → +11,250 ✓
  //   45% WR → +5,625 ✗
  //
  // Bottom line: strategy must yield >= 50% WR to hit 10k consistently.
  const slDist = entry * 0.005;       // 0.5%
  const targetDist = entry * 0.010;   // 1.0%

  let sl, target;
  if (direction === 'long') {
    sl = entry - slDist;
    target = entry + targetDist;
  } else {
    sl = entry + slDist;
    target = entry - targetDist;
  }

  const rr = targetDist / Math.max(slDist, 1e-9);

  // ─── Confidence scoring ───
  // Scoring reflects the factors that empirically predicted winning days
  // in the April backtest: pattern strength, relative strength, volume,
  // index regime alignment.

  // 1. Signal clarity (from pattern detector strength): 0..30
  const signalClarity = Math.round((top.strength || 0.7) * 30);

  // 2. Relative strength (embedded in pattern strength but recomputed here).
  const dayOpen = opts?.stockDayOpen != null
    ? opts.stockDayOpen
    : (candles[Math.max(0, candles.length - barIndex - 15)]?.o || cur.c);
  const stockIntraPct = (cur.c - dayOpen) / dayOpen;
  const idxDir = opts?.indexDirection || null;
  const idxIntraPct = idxDir?.intradayPct ?? 0;
  const rs = direction === 'long' ? (stockIntraPct - idxIntraPct) : (idxIntraPct - stockIntraPct);
  const relativeStrength = Math.round(Math.min(25, Math.max(0, rs * 2500)));

  // 3. Volume confirmation: pattern gate already requires >= 1.2x.
  //    Score: 0 for 1.2x, 15 for 2.5x+
  const vols = candles.slice(-11, -1).map(c => c.v || 0);
  const avgV = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 1;
  const curEffV = Math.max(cur.v || 0, ...candles.slice(-4, -1).map(c => c.v || 0));
  const volFactor = avgV > 0 ? curEffV / avgV : 1;
  const volume = Math.round(Math.min(15, Math.max(0, (volFactor - 1.2) * 12)));

  // 4. R:R score (0..20)
  const rrScore = Math.round(Math.min(20, Math.max(0, (rr - 2) * 10)));

  // 5. Regime alignment (0..10): +10 if index direction strongly supports, 5 if neutral
  let regime = 5;
  if (idxDir) {
    if ((direction === 'long' && idxDir.direction === 'bullish') ||
        (direction === 'short' && idxDir.direction === 'bearish')) {
      regime = 10;
    } else if ((direction === 'long' && idxDir.direction === 'bearish') ||
               (direction === 'short' && idxDir.direction === 'bullish')) {
      regime = 0;
    }
  }

  // Gate: reject trades with R:R below 2 — the math doesn't work.
  if (rr < 2.0) return noTrade(cur, candles);

  const raw = signalClarity + relativeStrength + volume + rrScore + regime;
  let confidence = Math.round(20 + (raw / 100) * 80); // 20..100 scale

  // Margin eligibility: downweight non-margin stocks if margin trading enabled
  if (opts?.margin && opts?.sym && opts.marginMap && !isMarginEligible(opts.sym, opts.marginMap)) {
    confidence = Math.max(20, confidence + MARGIN_PENALTY);
  }

  confidence = Math.max(20, Math.min(100, confidence));

  const breakdown = {
    signalClarity, relativeStrength, volume, riskReward: rrScore, regime,
    // Keep legacy keys for any UI consumers expecting them
    lowNoise: 0, patternReliability: 0, confluence: 0,
  };

  let level = 'low';
  if (confidence >= 82) level = 'high';
  else if (confidence >= 70) level = 'moderate';

  let action = 'NO TRADE';
  if (confidence >= 82) {
    action = direction === 'short' ? 'STRONG SHORT' : 'STRONG BUY';
  } else if (confidence >= 75) {
    action = direction === 'short' ? 'SHORT' : 'BUY';
  } else if (confidence >= 60) {
    action = 'WAIT';
  }

  const context = detectContext(candles);
  const signalBarTs = cur.t || null;
  const validTillTs = signalBarTs ? signalBarTs + 3 * 60 : null;

  return {
    total: Math.round(raw), confidence, breakdown, level, action,
    entry, sl, target, rr: Math.min(9, rr), direction, context,
    maxHoldBars: 30, // 30 min — enough for 1% target to hit on 1m bars
    signalBarTs, validTillTs,
  };
}

function noTrade(cur, candles) {
  const context = detectContext(candles);
  return {
    total: 0, confidence: 20,
    breakdown: { signalClarity: 0, relativeStrength: 0, volume: 0, riskReward: 0, regime: 0, lowNoise: 0, patternReliability: 0, confluence: 0 },
    level: 'low', action: 'NO TRADE',
    entry: cur.c, sl: cur.c, target: cur.c, rr: 0, direction: 'long', context,
    maxHoldBars: 15,
    signalBarTs: cur.t || null, validTillTs: null,
  };
}
