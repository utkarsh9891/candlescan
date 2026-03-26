/**
 * Detect consolidation box in last 20 candles; breakout / trap hints.
 * Returns startIdx / endIdx relative to the input candles array so the
 * chart can position the box over the correct candles.
 */

function avgRange(candles) {
  if (!candles.length) return 0;
  const s = candles.reduce((a, c) => a + (c.h - c.l), 0);
  return s / candles.length;
}

/** @param {Array<{o:number,h:number,l:number,c:number,v:number}>} candles */
export function detectLiquidityBox(candles) {
  if (!candles || candles.length < 10) return null;

  const winStart = Math.max(0, candles.length - 20);
  const win = candles.slice(winStart);
  const ar = avgRange(win);
  if (ar <= 0) return null;

  let best = null;
  for (let len = 5; len <= 8; len++) {
    for (let i = win.length - len; i >= 0; i--) {
      const seg = win.slice(i, i + len);
      const hi = Math.max(...seg.map((c) => c.h));
      const lo = Math.min(...seg.map((c) => c.l));
      const boxR = hi - lo;
      if (boxR < ar * len * 0.5 && boxR < ar * 3) {
        const score = len / boxR;
        if (!best || score > best.score) {
          best = { hi, lo, len, i, boxR, score };
        }
      }
    }
  }

  if (!best) return null;

  const { hi, lo, boxR } = best;
  const mz = boxR * 0.25;
  const cur = candles[candles.length - 1];

  // Indices relative to the full candles array
  const startIdx = winStart + best.i;
  const endIdx = startIdx + best.len - 1;

  let breakout = 'none';
  if (cur.c > hi) breakout = 'bullish';
  else if (cur.c < lo) breakout = 'bearish';

  let trap = 'none';
  if (cur.h > hi && cur.c <= hi && cur.c >= lo) trap = 'bull_trap';
  else if (cur.l < lo && cur.c >= lo && cur.c <= hi) trap = 'bear_trap';

  return {
    high: hi,
    low: lo,
    range: boxR,
    manipulationZone: mz,
    consolidationLen: best.len,
    startIdx,
    endIdx,
    breakout,
    trap,
  };
}
