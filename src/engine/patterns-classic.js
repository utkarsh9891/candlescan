/**
 * Classic (Swing) pattern detection engine.
 * Optimized for daily candles, 3-4 day holds.
 *
 * Patterns (7 swing-specific):
 *  1. Moving Average Crossover (20/50 SMA)
 *  2. Support/Resistance Bounce
 *  3. Trend Channel Breakout
 *  4. Volume Surge + Trend
 *  5. Higher High / Lower Low (Swing Structure)
 *  6. Daily Engulfing
 *  7. Gap with Follow-Through
 */

function body(c) { return Math.abs(c.c - c.o); }
function range(c) { return c.h - c.l; }
function isBull(c) { return c.c >= c.o; }

function sma(candles, period, field = 'c') {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  return slice.reduce((s, c) => s + c[field], 0) / period;
}

function avgVolume(candles, n = 20) {
  const slice = candles.slice(-n);
  if (!slice.length) return 0;
  return slice.reduce((s, c) => s + (c.v || 0), 0) / slice.length;
}

function avgBody(candles, n = 10) {
  const slice = candles.slice(-n - 1, -1);
  if (!slice.length) return 1;
  return slice.reduce((s, c) => s + body(c), 0) / slice.length || 1;
}

/**
 * @param {Array} candles — daily candle array (6 months history)
 */
export function detectPatterns(candles) {
  if (!candles?.length || candles.length < 50) return [];

  const n = candles.length;
  const cur = candles[n - 1];
  const prev = candles[n - 2];
  const patterns = [];
  const ab = avgBody(candles, 10);
  const av = avgVolume(candles, 20);
  const vf = av > 0 ? Math.min(2.5, (cur.v || 0) / av) : 1;

  // --- 1. Moving Average Crossover (20/50 SMA) ---
  if (n >= 52) {
    const sma20now = sma(candles, 20);
    const sma50now = sma(candles, 50);
    const sma20prev = sma(candles.slice(0, -1), 20);
    const sma50prev = sma(candles.slice(0, -1), 50);

    if (sma20now && sma50now && sma20prev && sma50prev) {
      // Golden cross: SMA20 crosses above SMA50
      if (sma20prev <= sma50prev && sma20now > sma50now) {
        patterns.push({
          name: 'Golden Cross (20/50)', direction: 'bullish',
          strength: Math.min(0.90, 0.70 * Math.min(1.5, vf)),
          category: 'ma-cross', emoji: '✕',
          tip: 'SMA 20 crossed above SMA 50 — institutional trend shift',
          description: 'Medium-term moving average crossed above long-term. Classic bullish trend signal used by institutions.',
          reliability: 0.65, candleIndices: [n - 1],
        });
      }
      // Death cross: SMA20 crosses below SMA50
      if (sma20prev >= sma50prev && sma20now < sma50now) {
        patterns.push({
          name: 'Death Cross (20/50)', direction: 'bearish',
          strength: Math.min(0.90, 0.68 * Math.min(1.5, vf)),
          category: 'ma-cross', emoji: '✕',
          tip: 'SMA 20 crossed below SMA 50 — bearish trend shift',
          description: 'Medium-term moving average crossed below long-term. Classic bearish trend signal.',
          reliability: 0.63, candleIndices: [n - 1],
        });
      }
      // Price above both SMAs with trend alignment
      if (cur.c > sma20now && sma20now > sma50now && isBull(cur)) {
        patterns.push({
          name: 'MA Trend Aligned (Bull)', direction: 'bullish',
          strength: Math.min(0.80, 0.55 * Math.min(1.5, vf)),
          category: 'ma-cross', emoji: '📈',
          tip: 'Price above 20 & 50 SMA — strong uptrend',
          description: 'Price trading above both moving averages with bullish candle. Trend continuation.',
          reliability: 0.58, candleIndices: [n - 1],
        });
      }
      if (cur.c < sma20now && sma20now < sma50now && !isBull(cur)) {
        patterns.push({
          name: 'MA Trend Aligned (Bear)', direction: 'bearish',
          strength: Math.min(0.80, 0.53 * Math.min(1.5, vf)),
          category: 'ma-cross', emoji: '📉',
          tip: 'Price below 20 & 50 SMA — strong downtrend',
          description: 'Price trading below both moving averages with bearish candle.',
          reliability: 0.56, candleIndices: [n - 1],
        });
      }
    }
  }

  // --- 2. Support/Resistance Bounce ---
  if (n >= 20) {
    const lows20 = candles.slice(-20).map(c => c.l);
    const highs20 = candles.slice(-20).map(c => c.h);
    const support = Math.min(...lows20);
    const resistance = Math.max(...highs20);
    const rangeSize = resistance - support || 1;

    // Bounce off support
    if (cur.l <= support * 1.005 && isBull(cur) && body(cur) > ab * 0.8) {
      patterns.push({
        name: 'Support Bounce', direction: 'bullish',
        strength: Math.min(0.85, 0.65 * Math.min(1.5, vf)),
        category: 'support-resistance', emoji: '⬆️',
        tip: `Bounced off 20-day support (${support.toFixed(1)})`,
        description: `Price touched 20-day support level and bounced with a strong bullish candle.`,
        reliability: 0.62, candleIndices: [n - 1],
      });
    }
    // Rejection at resistance
    if (cur.h >= resistance * 0.995 && !isBull(cur) && body(cur) > ab * 0.8) {
      patterns.push({
        name: 'Resistance Rejection', direction: 'bearish',
        strength: Math.min(0.85, 0.63 * Math.min(1.5, vf)),
        category: 'support-resistance', emoji: '⬇️',
        tip: `Rejected at 20-day resistance (${resistance.toFixed(1)})`,
        description: `Price hit 20-day resistance level and reversed with a bearish candle.`,
        reliability: 0.60, candleIndices: [n - 1],
      });
    }
  }

  // --- 3. Trend Channel Breakout ---
  if (n >= 15) {
    const recent15 = candles.slice(-15, -1); // exclude current bar
    const channelHigh = Math.max(...recent15.map(c => c.h));
    const channelLow = Math.min(...recent15.map(c => c.l));

    if (cur.c > channelHigh && isBull(cur) && vf > 1.3) {
      patterns.push({
        name: 'Channel Breakout (Bull)', direction: 'bullish',
        strength: Math.min(0.92, 0.72 * Math.min(1.8, vf)),
        category: 'channel', emoji: '🔓',
        tip: `Broke above 15-day channel high (${channelHigh.toFixed(1)})`,
        description: 'Price broke above the 15-day trading channel with volume confirmation.',
        reliability: 0.66, candleIndices: [n - 1],
      });
    }
    if (cur.c < channelLow && !isBull(cur) && vf > 1.3) {
      patterns.push({
        name: 'Channel Breakdown (Bear)', direction: 'bearish',
        strength: Math.min(0.92, 0.70 * Math.min(1.8, vf)),
        category: 'channel', emoji: '🔓',
        tip: `Broke below 15-day channel low (${channelLow.toFixed(1)})`,
        description: 'Price broke below the 15-day trading channel with volume confirmation.',
        reliability: 0.64, candleIndices: [n - 1],
      });
    }
  }

  // --- 4. Volume Surge + Trend ---
  if (vf >= 2.0 && body(cur) > ab * 1.5) {
    patterns.push({
      name: isBull(cur) ? 'Volume Surge (Bull)' : 'Volume Surge (Bear)',
      direction: isBull(cur) ? 'bullish' : 'bearish',
      strength: Math.min(0.88, 0.60 * Math.min(2, vf / 1.5)),
      category: 'volume-surge', emoji: '📊',
      tip: `Volume ${(vf).toFixed(1)}× average with strong directional candle`,
      description: 'Massive volume spike with a directional candle. Institutional activity — trend likely to continue for 2-3 days.',
      reliability: 0.60, candleIndices: [n - 1],
    });
  }

  // --- 5. Higher High / Lower Low (Swing Structure) ---
  if (n >= 10) {
    const recent5 = candles.slice(-6, -1);
    const prevHigh = Math.max(...recent5.map(c => c.h));
    const prevLow = Math.min(...recent5.map(c => c.l));
    const older5 = candles.slice(-11, -6);
    const olderHigh = Math.max(...older5.map(c => c.h));
    const olderLow = Math.min(...older5.map(c => c.l));

    // Higher high + higher low = uptrend continuation
    if (prevHigh > olderHigh && prevLow > olderLow && isBull(cur)) {
      patterns.push({
        name: 'Higher High (Uptrend)', direction: 'bullish',
        strength: Math.min(0.82, 0.58 * Math.min(1.5, vf)),
        category: 'swing-structure', emoji: '📈',
        tip: 'Swing highs and lows rising — uptrend intact',
        description: 'Recent swing high exceeds prior swing high with higher lows. Classic uptrend structure.',
        reliability: 0.60, candleIndices: [n - 1],
      });
    }
    // Lower low + lower high = downtrend continuation
    if (prevLow < olderLow && prevHigh < olderHigh && !isBull(cur)) {
      patterns.push({
        name: 'Lower Low (Downtrend)', direction: 'bearish',
        strength: Math.min(0.82, 0.56 * Math.min(1.5, vf)),
        category: 'swing-structure', emoji: '📉',
        tip: 'Swing highs and lows falling — downtrend intact',
        description: 'Recent swing low below prior swing low with lower highs. Classic downtrend structure.',
        reliability: 0.58, candleIndices: [n - 1],
      });
    }
  }

  // --- 6. Daily Engulfing ---
  if (prev) {
    const pb = body(prev);
    const cb = body(cur);
    if (!isBull(prev) && isBull(cur) && cur.o <= prev.c && cur.c >= prev.o && cb >= pb * 0.95) {
      patterns.push({
        name: 'Daily Engulfing (Bull)', direction: 'bullish',
        strength: Math.min(0.88, 0.70 * Math.min(1.5, vf)),
        category: 'daily-engulfing', emoji: '🟢',
        tip: 'Daily bullish engulfing — strong reversal',
        description: 'Bullish candle fully engulfs prior bearish candle on daily chart. High-reliability swing reversal.',
        reliability: 0.68, candleIndices: [n - 2, n - 1],
      });
    }
    if (isBull(prev) && !isBull(cur) && cur.o >= prev.c && cur.c <= prev.o && cb >= pb * 0.95) {
      patterns.push({
        name: 'Daily Engulfing (Bear)', direction: 'bearish',
        strength: Math.min(0.88, 0.68 * Math.min(1.5, vf)),
        category: 'daily-engulfing', emoji: '🔴',
        tip: 'Daily bearish engulfing — strong reversal',
        description: 'Bearish candle fully engulfs prior bullish candle on daily chart. High-reliability swing reversal.',
        reliability: 0.66, candleIndices: [n - 2, n - 1],
      });
    }
  }

  // --- 7. Gap with Follow-Through ---
  if (prev) {
    const gapUp = cur.o > prev.h;
    const gapDown = cur.o < prev.l;

    if (gapUp && isBull(cur) && body(cur) > ab * 0.5) {
      patterns.push({
        name: 'Gap Up + Follow-Through', direction: 'bullish',
        strength: Math.min(0.90, 0.68 * Math.min(1.8, vf)),
        category: 'gap', emoji: '⬆️',
        tip: 'Gapped up and held — momentum entry',
        description: 'Price gapped above prior high and continued higher. Institutional buying with conviction.',
        reliability: 0.62, candleIndices: [n - 2, n - 1],
      });
    }
    if (gapDown && !isBull(cur) && body(cur) > ab * 0.5) {
      patterns.push({
        name: 'Gap Down + Follow-Through', direction: 'bearish',
        strength: Math.min(0.90, 0.66 * Math.min(1.8, vf)),
        category: 'gap', emoji: '⬇️',
        tip: 'Gapped down and continued selling',
        description: 'Price gapped below prior low and continued lower. Institutional selling pressure.',
        reliability: 0.60, candleIndices: [n - 2, n - 1],
      });
    }
  }

  patterns.sort((a, b) => b.strength - a.strength);
  return patterns;
}
