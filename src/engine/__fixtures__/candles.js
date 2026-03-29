/**
 * Reusable candle data for unit tests.
 * Each set is designed to trigger specific patterns or conditions.
 */

const t = 1700000000; // base timestamp

/** Bullish engulfing: small red candle followed by large green candle that engulfs it. */
export const bullishEngulfing = [
  // Prior downtrend (5 candles)
  { t: t,     o: 110, h: 111, l: 108, c: 108.5, v: 100000 },
  { t: t+60,  o: 108.5, h: 109, l: 107, c: 107.5, v: 120000 },
  { t: t+120, o: 107.5, h: 108, l: 106, c: 106.5, v: 110000 },
  { t: t+180, o: 106.5, h: 107, l: 105, c: 105.5, v: 130000 },
  { t: t+240, o: 105.5, h: 106, l: 104, c: 104.5, v: 100000 },
  // Engulfing pair
  { t: t+300, o: 104.5, h: 105, l: 103.5, c: 104, v: 80000 },  // small red
  { t: t+360, o: 103.5, h: 106, l: 103,   c: 105.5, v: 200000 }, // large green engulfs
];

/** Bearish engulfing: small green candle followed by large red candle. */
export const bearishEngulfing = [
  // Prior uptrend
  { t: t,     o: 100, h: 101.5, l: 99.5, c: 101, v: 100000 },
  { t: t+60,  o: 101, h: 102.5, l: 100.5, c: 102, v: 120000 },
  { t: t+120, o: 102, h: 103.5, l: 101.5, c: 103, v: 110000 },
  { t: t+180, o: 103, h: 104.5, l: 102.5, c: 104, v: 130000 },
  { t: t+240, o: 104, h: 105.5, l: 103.5, c: 105, v: 100000 },
  // Engulfing pair
  { t: t+300, o: 105, h: 105.8, l: 104.8, c: 105.5, v: 80000 },  // small green
  { t: t+360, o: 105.8, h: 106,   l: 103,   c: 103.5, v: 250000 }, // large red engulfs
];

/** Hammer: long lower wick, small body near top, after downtrend. */
export const hammerPattern = [
  // Downtrend
  { t: t,     o: 120, h: 121, l: 118, c: 118.5, v: 100000 },
  { t: t+60,  o: 118.5, h: 119, l: 116, c: 116.5, v: 120000 },
  { t: t+120, o: 116.5, h: 117, l: 114, c: 114.5, v: 110000 },
  { t: t+180, o: 114.5, h: 115, l: 112, c: 112.5, v: 130000 },
  { t: t+240, o: 112.5, h: 113, l: 110, c: 110.5, v: 100000 },
  // Hammer: body at top, long lower wick
  { t: t+300, o: 110, h: 110.5, l: 106, c: 110.3, v: 180000 },
];

/** Consolidation: 10 tight-range candles for liquidity box detection. */
export const consolidation = Array.from({ length: 15 }, (_, i) => ({
  t: t + i * 60,
  o: 100 + (i % 2 === 0 ? 0.2 : -0.2),
  h: 100.8 + (i % 3) * 0.1,
  l: 99.3 - (i % 3) * 0.1,
  c: 100 + (i % 2 === 0 ? -0.1 : 0.3),
  v: 50000 + (i % 4) * 5000,
}));

/** Consolidation + breakout: tight box then a strong move up. */
export const consolidationBreakout = [
  ...consolidation,
  { t: t + 15 * 60, o: 100.5, h: 103, l: 100.3, c: 102.8, v: 300000 },
];

/** Flat trailing candles (for trimTrailingFlatCandles test). */
export const withTrailingFlats = [
  { t: t,     o: 100, h: 102, l: 99, c: 101, v: 100000 },
  { t: t+60,  o: 101, h: 103, l: 100, c: 102, v: 120000 },
  { t: t+120, o: 102, h: 104, l: 101, c: 103, v: 110000 },
  { t: t+180, o: 103, h: 105, l: 102, c: 104, v: 130000 },
  { t: t+240, o: 104, h: 106, l: 103, c: 105, v: 100000 },
  { t: t+300, o: 105, h: 106, l: 104, c: 105.5, v: 90000 },
  // Flat trailing candles (O ≈ H ≈ L ≈ C)
  { t: t+360, o: 105.5, h: 105.5, l: 105.5, c: 105.5, v: 0 },
  { t: t+420, o: 105.5, h: 105.5, l: 105.5, c: 105.5, v: 0 },
];

/** Sideways / no pattern: random small moves, no clear trend. */
export const sideways = Array.from({ length: 10 }, (_, i) => ({
  t: t + i * 60,
  o: 100 + Math.sin(i) * 0.3,
  h: 100.5 + Math.sin(i) * 0.3,
  l: 99.5 + Math.sin(i) * 0.3,
  c: 100.1 + Math.sin(i) * 0.3,
  v: 100000,
}));

/** Yahoo chart API JSON response (for parseChartJson test). */
export const yahooChartJson = {
  chart: {
    result: [{
      meta: { longName: 'Reliance Industries', symbol: 'RELIANCE.NS' },
      timestamp: [t, t+60, t+120],
      indicators: {
        quote: [{
          open: [100, 101, 102],
          high: [102, 103, 104],
          low: [99, 100, 101],
          close: [101, 102, 103],
          volume: [100000, 120000, 110000],
        }],
      },
    }],
  },
};
