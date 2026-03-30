/**
 * Classic (Swing) risk scoring engine.
 * Optimized for 3-4 day holds on daily candles.
 *
 * Key differences from intraday/scalp:
 *  - Wider SL (ATR×2.5, ~2-3% of price)
 *  - Wider target (ATR×4.0, ~5-8%)
 *  - No time-based exit (hold across days)
 *  - No index direction filter (multi-day trends are independent)
 *  - Higher volume gate (100,000 daily)
 *  - 0.2% slippage (next-day gap risk)
 */

export const RISK_SIGNAL_DEFINITIONS = [
  { key: 'signalClarity', label: 'Signal clarity', max: 25, meaning: 'Pattern strength × volume factor × 25.' },
  { key: 'lowNoise', label: 'Low noise', max: 20, meaning: 'ATR vs body; clean trends score higher.' },
  { key: 'riskReward', label: 'Risk : reward', max: 25, meaning: 'Continuous scoring of R:R ratio.' },
  { key: 'patternReliability', label: 'Pattern reliability', max: 15, meaning: 'Built-in reliability × 15.' },
  { key: 'confluence', label: 'Confluence', max: 15, meaning: 'Volume, SMA alignment, context.' },
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

export function detectContext(candles, box) {
  if (!candles || candles.length < 5) return 'mid_range';
  const cur = candles[candles.length - 1];
  const window = candles.slice(-30); // wider window for daily
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

export function computeRiskScore({ candles, patterns, box }) {
  const top = patterns?.length ? patterns[0] : null;
  const cur = candles[candles.length - 1];

  // Volume gate: daily volume > 100,000
  if ((cur.v || 0) < 100000) return noTrade(cur, candles, box);

  /* ── 1. Signal clarity (max 25) — volume-weighted ──────────── */
  const vols = candles.slice(-21, -1).map(c => c.v || 0);
  const avgV = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 1;
  const volFactor = avgV > 0 ? Math.min(2, (cur.v || 0) / avgV) : 1;
  const signalClarity = top ? Math.min(25, top.strength * volFactor * 25) : 2;

  /* ── 2. Low noise (max 20) ─────────────────────────────────── */
  const bodies = candles.slice(-11, -1).map(c => Math.abs(c.c - c.o));
  const avgBody = bodies.reduce((a, b) => a + b, 0) / Math.max(bodies.length, 1) || 1;
  const atr10 = atrLike(candles, 10);
  const chop = Math.min(1, atr10 / (avgBody * 3));
  const lowNoise = (1 - chop) * 20;

  /* ── 3. Risk:Reward (max 25) — swing levels ────────────────── */
  const direction = top?.direction === 'bearish' ? 'short' : top?.direction === 'bullish' ? 'long' : 'long';
  const atrVal = atrLike(candles, 14);

  // 0.2% slippage for daily (next-day gap risk)
  const rawEntry = cur.c;
  const entry = direction === 'long' ? rawEntry * 1.002 : rawEntry * 0.998;

  // SL: ATR × 2.5 (~2-3% of price on daily)
  const slDist = atrVal * 2.5;
  let targetDist, sl, target;

  if (direction === 'long') {
    sl = entry - slDist;
    const resistance = Math.max(...candles.slice(-30).map(c => c.h));
    const resistanceDist = resistance - entry;
    targetDist = resistanceDist > slDist ? resistanceDist : atrVal * 4.0;
    target = entry + targetDist;
  } else {
    sl = entry + slDist;
    const support = Math.min(...candles.slice(-30).map(c => c.l));
    const supportDist = entry - support;
    targetDist = supportDist > slDist ? supportDist : atrVal * 4.0;
    target = entry - targetDist;
  }

  const rr = targetDist / Math.max(slDist, 1e-9);
  const rrClamped = Math.min(5, Math.max(0.3, rr));
  const rrScore = Math.round(25 * (1 - Math.exp(-0.5 * rrClamped)));

  // Min R:R 1.5 for swing
  if (rr < 1.5) return noTrade(cur, candles, box);

  // Transaction cost filter (0.5% for delivery/swing — STT + brokerage + holding)
  if (targetDist < entry * 0.005) return noTrade(cur, candles, box);

  /* ── 4. Pattern reliability (max 15) ───────────────────────── */
  const patternRel = top ? top.reliability * 15 : 3;

  /* ── 5. Confluence (max 15) ────────────────────────────────── */
  let confluence = 0;

  // Volume spike
  if (avgV > 0 && cur.v > avgV * 2) confluence += 5;
  else if (avgV > 0 && cur.v > avgV * 1.3) confluence += 3;

  // SMA alignment (20/50)
  const closes = candles.map(c => c.c);
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  if (s20 != null && s50 != null) {
    if (direction === 'long' && s20 > s50) confluence += 5;
    if (direction === 'short' && s20 < s50) confluence += 5;
    if (direction === 'long' && s20 < s50) confluence -= 3;
    if (direction === 'short' && s20 > s50) confluence -= 3;
  }

  // Context alignment
  const context = detectContext(candles, box);
  if (top?.direction === 'bullish' && context === 'at_support') confluence += 4;
  else if (top?.direction === 'bearish' && context === 'at_resistance') confluence += 4;
  else if (top?.direction === 'bullish' && context === 'at_resistance') confluence -= 3;
  else if (top?.direction === 'bearish' && context === 'at_support') confluence -= 3;
  else if (context === 'breakout') confluence += 3;

  // Box breakout
  if (box && box.breakout !== 'none') {
    confluence += Math.round(2 + (box.quality || 0) * 3);
  }

  confluence = Math.max(0, confluence);

  /* ── Raw → Confidence ──────────────────────────────────────── */
  const raw = signalClarity + lowNoise + rrScore + patternRel + Math.min(15, confluence);
  const rawClamped = Math.min(100, Math.round(raw));
  const confidence = Math.round(30 + (rawClamped / 100) * 70);

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

  return { total: rawClamped, confidence, breakdown, level, action, entry, sl, target, rr: rrClamped, direction, context };
}

function noTrade(cur, candles, box) {
  const context = detectContext(candles, box);
  return {
    total: 0, confidence: 30, breakdown: { signalClarity: 0, lowNoise: 0, riskReward: 0, patternReliability: 0, confluence: 0 },
    level: 'low', action: 'NO TRADE',
    entry: cur.c, sl: cur.c, target: cur.c, rr: 0, direction: 'long', context,
  };
}
