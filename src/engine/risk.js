/**
 * Risk score 0-100 + trade action hints.
 */

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
    const tr = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    s += tr;
  }
  return s / m;
}

/**
 * @param {object} params
 * @param {import('./patterns.js').Candle[]} params.candles
 * @param {ReturnType<import('./patterns.js').detectPatterns>} params.patterns
 * @param {ReturnType<import('./liquidityBox.js').detectLiquidityBox>} params.box
 */
export function computeRiskScore({ candles, patterns, box }) {
  const top = patterns?.length ? patterns[0] : null;
  const cur = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || cur;

  const signalClarity = top ? top.strength * 25 : 2;

  const bodies = candles.slice(-6, -1).map((c) => Math.abs(c.c - c.o));
  const avgBody = bodies.reduce((a, b) => a + b, 0) / Math.max(bodies.length, 1) || 1;
  const atr = atrLike(candles, 10);
  const chop = Math.min(1, atr / (avgBody * 3));
  const lowNoise = (1 - chop) * 20;

  const direction =
    top?.direction === 'bearish' ? 'short' : top?.direction === 'bullish' ? 'long' : 'long';
  let slDist;
  if (direction === 'long') {
    slDist = Math.max(cur.c - prev.l, cur.c * 0.002);
  } else {
    slDist = Math.max(prev.h - cur.c, cur.c * 0.002);
  }
  const targetDist = slDist * 2;
  const rr = targetDist / Math.max(slDist, 1e-9);
  let rrScore = 5;
  if (rr >= 2) rrScore = 25;
  else if (rr >= 1.5) rrScore = 18;
  else if (rr >= 1) rrScore = 10;

  const patternRel = top ? top.reliability * 15 : 3;

  let confluence = 0;
  const vols = candles.slice(-11, -1).map((c) => c.v || 0);
  const avgV = vols.reduce((a, b) => a + b, 0) / Math.max(vols.length, 1);
  if (avgV > 0 && cur.v > avgV * 1.3) confluence += 5;

  const closes = candles.map((c) => c.c);
  const s10 = sma(closes, 10);
  const s20 = sma(closes, 20);
  if (s10 != null && s20 != null) {
    if (top?.direction === 'bullish' && s10 > s20) confluence += 5;
    if (top?.direction === 'bearish' && s10 < s20) confluence += 5;
    if (top?.direction === 'neutral') confluence += 2;
  }

  if (box && (box.breakout !== 'none' || box.trap !== 'none')) confluence += 5;

  const raw =
    signalClarity + lowNoise + rrScore + patternRel + Math.min(15, confluence);
  const total = Math.min(100, Math.round(raw));

  const breakdown = {
    signalClarity: Math.round(signalClarity),
    lowNoise: Math.round(lowNoise),
    riskReward: rrScore,
    patternReliability: Math.round(patternRel),
    confluence: Math.min(15, Math.round(confluence)),
  };

  let level = 'high';
  if (total >= 65) level = 'low';
  else if (total >= 40) level = 'moderate';

  let action = 'SKIP';
  if (total >= 50 && top && top.direction !== 'neutral') {
    action = top.direction === 'bearish' ? 'SHORT' : 'BUY';
  } else if (total >= 35 && top) action = 'WAIT';

  const entry = cur.c;
  const sl = direction === 'long' ? prev.l : prev.h;
  const target = direction === 'long' ? entry + (entry - sl) * 2 : entry - (sl - entry) * 2;

  return {
    total,
    breakdown,
    level,
    action,
    entry,
    sl,
    target,
    rr,
    direction,
  };
}
