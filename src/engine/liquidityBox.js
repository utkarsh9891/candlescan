/**
 * Detect consolidation box in recent candles; breakout / trap hints.
 * Returns startIdx / endIdx relative to the input candles array so the
 * chart can position the box over the correct candles.
 *
 * v2: volume-aware detection, wider segment search (5–12), composite
 *     quality score, graduated breakout strength & trap depth.
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

  for (let len = 5; len <= Math.min(12, win.length); len++) {
    for (let i = win.length - len; i >= 0; i--) {
      const seg = win.slice(i, i + len);
      const hi = Math.max(...seg.map((c) => c.h));
      const lo = Math.min(...seg.map((c) => c.l));
      const boxR = hi - lo;

      // ATR-relative threshold: box range must be tight
      if (boxR >= atr14 * 2.5) continue;
      if (boxR <= 0) continue;

      // Volume analysis: compare box volume to preceding candles
      const segVol = avgVolume(seg);
      const precedingStart = Math.max(0, i - len);
      const preceding = win.slice(precedingStart, i);
      const precVol = preceding.length >= 3 ? avgVolume(preceding) : segVol;
      const volumeRatio = precVol > 0 ? segVol / precVol : 1;

      // Composite score: tightness + length + volume decline
      const tightness = Math.min(2, ar / boxR);               // how tight vs normal range
      const lenScore = Math.log2(len / 4);                     // log-scaled length bonus
      const volScore = precVol > 0 ? Math.min(1.5, precVol / Math.max(segVol, 1)) : 0.5;
      const score = tightness * 1.5 + lenScore + volScore;

      if (!best || score > best.score) {
        best = { hi, lo, len, i, boxR, score, volumeRatio, tightness, volScore };
      }
    }
  }

  if (!best) return null;

  const { hi, lo, boxR, volumeRatio, tightness, volScore } = best;
  const mz = boxR * 0.25;
  const cur = candles[candles.length - 1];

  // Indices relative to the full candles array
  const startIdx = winStart + best.i;
  const endIdx = startIdx + best.len - 1;

  // Quality: composite 0–1 from tightness, length, and volume
  const quality = Math.min(1, (tightness / 2) * 0.4 + (Math.min(1, best.len / 10)) * 0.3 + (volScore / 1.5) * 0.3);

  // Breakout detection with strength
  let breakout = 'none';
  let breakoutStrength = 0;
  if (cur.c > hi) {
    breakout = 'bullish';
    breakoutStrength = Math.min(1, (cur.c - hi) / Math.max(boxR, 1e-9));
  } else if (cur.c < lo) {
    breakout = 'bearish';
    breakoutStrength = Math.min(1, (lo - cur.c) / Math.max(boxR, 1e-9));
  }

  // Trap detection with depth (ignore shallow wicks < 30% of mz)
  let trap = 'none';
  let trapDepth = 0;
  if (breakout === 'none' && mz > 0) {
    if (cur.h > hi && cur.c <= hi && cur.c >= lo) {
      trapDepth = Math.min(1, (cur.h - hi) / mz);
      if (trapDepth > 0.3) trap = 'bull_trap';
      else trapDepth = 0;
    } else if (cur.l < lo && cur.c >= lo && cur.c <= hi) {
      trapDepth = Math.min(1, (lo - cur.l) / mz);
      if (trapDepth > 0.3) trap = 'bear_trap';
      else trapDepth = 0;
    }
  }

  return {
    high: hi,
    low: lo,
    range: boxR,
    manipulationZone: mz,
    consolidationLen: best.len,
    startIdx,
    endIdx,
    breakout,
    breakoutStrength,
    trap,
    trapDepth,
    volumeRatio,
    quality,
  };
}
