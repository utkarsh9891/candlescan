/**
 * Liquidity box detection v2.
 * Fixes from adversarial review:
 *  - Wider segment search: 4-15 candles (was 5-12)
 *  - Breakout uses candle high/low, not close
 *  - Trap threshold: 0.2 (was 0.3)
 *  - Quality weights: 35% tightness, 35% volume, 30% length
 */

function avgRange(candles) {
  if (!candles.length) return 0;
  return candles.reduce((a, c) => a + (c.h - c.l), 0) / candles.length;
}

function avgVolume(candles) {
  if (!candles.length) return 0;
  return candles.reduce((a, c) => a + (c.v || 0), 0) / candles.length;
}

function atr(candles, n) {
  if (candles.length < 2) return avgRange(candles);
  const m = Math.min(n, candles.length - 1);
  let s = 0;
  for (let i = candles.length - m; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    s += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  }
  return s / m;
}

/** @param {Array<{o:number,h:number,l:number,c:number,v:number}>} candles */
export function detectLiquidityBox(candles) {
  if (!candles || candles.length < 10) return null;

  const winStart = Math.max(0, candles.length - 25);
  const win = candles.slice(winStart);
  const ar = avgRange(win);
  const atr14 = atr(candles, 14);
  if (ar <= 0 || atr14 <= 0) return null;

  let best = null;

  // FIX: wider segment search 4-15 (was 5-12)
  for (let len = 4; len <= Math.min(15, win.length); len++) {
    for (let i = win.length - len; i >= 0; i--) {
      const seg = win.slice(i, i + len);
      const hi = Math.max(...seg.map(c => c.h));
      const lo = Math.min(...seg.map(c => c.l));
      const boxR = hi - lo;

      if (boxR >= atr14 * 2.5) continue;
      if (boxR <= 0) continue;

      const segVol = avgVolume(seg);
      const precedingStart = Math.max(0, i - len);
      const preceding = win.slice(precedingStart, i);
      const precVol = preceding.length >= 3 ? avgVolume(preceding) : segVol;

      const tightness = Math.min(2, ar / boxR);
      const lenScore = Math.log2(len / 4);
      const volScore = precVol > 0 ? Math.min(1.5, precVol / Math.max(segVol, 1)) : 0.5;
      const score = tightness * 1.5 + lenScore + volScore;

      if (!best || score > best.score) {
        best = { hi, lo, len, i, boxR, score, tightness, volScore };
      }
    }
  }

  if (!best) return null;

  const { hi, lo, boxR, tightness, volScore } = best;
  const mz = boxR * 0.25;
  const cur = candles[candles.length - 1];

  const startIdx = winStart + best.i;
  const endIdx = startIdx + best.len - 1;

  // FIX: quality weights 35% tightness, 35% volume, 30% length (was 40-30-30)
  const quality = Math.min(1,
    (tightness / 2) * 0.35 +
    (volScore / 1.5) * 0.35 +
    (Math.min(1, best.len / 10)) * 0.30
  );

  // FIX: breakout uses high/low, not close
  let breakout = 'none';
  let breakoutStrength = 0;
  if (cur.h > hi && cur.c > hi) {
    breakout = 'bullish';
    breakoutStrength = Math.min(1, (cur.c - hi) / Math.max(boxR, 1e-9));
  } else if (cur.l < lo && cur.c < lo) {
    breakout = 'bearish';
    breakoutStrength = Math.min(1, (lo - cur.c) / Math.max(boxR, 1e-9));
  }

  // FIX: trap threshold 0.2 (was 0.3)
  let trap = 'none';
  let trapDepth = 0;
  if (breakout === 'none' && mz > 0) {
    if (cur.h > hi && cur.c <= hi && cur.c >= lo) {
      trapDepth = Math.min(1, (cur.h - hi) / mz);
      if (trapDepth > 0.2) trap = 'bull_trap';
      else trapDepth = 0;
    } else if (cur.l < lo && cur.c >= lo && cur.c <= hi) {
      trapDepth = Math.min(1, (lo - cur.l) / mz);
      if (trapDepth > 0.2) trap = 'bear_trap';
      else trapDepth = 0;
    }
  }

  return {
    high: hi, low: lo, range: boxR, manipulationZone: mz,
    consolidationLen: best.len, startIdx, endIdx,
    breakout, breakoutStrength, trap, trapDepth, quality,
  };
}
