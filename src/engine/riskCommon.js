/**
 * Shared numeric helpers used by every pattern/risk engine.
 *
 * Kept in one place to eliminate the 3-4x duplication the helpers
 * previously had across risk.js, risk-classic.js, risk-v2.js,
 * risk-scalp.js, and patterns-scalp.js.
 *
 * Every function is a pure numeric utility over an OHLCV candle array.
 */

/** Simple moving average of the last `n` numbers. */
export function sma(vals, n) {
  if (!vals.length || n < 1) return null;
  const slice = vals.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/**
 * ATR-like volatility estimator over the last `n` candles.
 * True range per bar = max(h-l, |h - prev.c|, |l - prev.c|).
 * Returns 0 when fewer than 2 candles are available.
 */
export function atrLike(candles, n = 14) {
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

/**
 * Volume-weighted typical-price average over the last `n` candles.
 * Falls back to `null` if no volume is available.
 */
export function vwapProxy(candles, n = 20) {
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
