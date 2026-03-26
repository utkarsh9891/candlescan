/** @typedef {{ o:number,h:number,l:number,c:number,v:number,t?:number }} Candle */

function body(c) {
  return Math.abs(c.c - c.o);
}
function range(c) {
  return c.h - c.l;
}
function upperWick(c) {
  const top = Math.max(c.o, c.c);
  return c.h - top;
}
function lowerWick(c) {
  const bot = Math.min(c.o, c.c);
  return bot - c.l;
}
function isBull(c) {
  return c.c >= c.o;
}
function midBody(c) {
  return (Math.max(c.o, c.c) + Math.min(c.o, c.c)) / 2;
}

function priorTrend(candles, idx, lookback, dir) {
  let up = 0,
    down = 0;
  const start = Math.max(0, idx - lookback);
  for (let i = start; i < idx; i++) {
    if (isBull(candles[i])) up++;
    else down++;
  }
  if (dir === 'down') return down >= up;
  if (dir === 'up') return up >= down;
  return true;
}

/**
 * @param {Candle[]} candles
 */
export function detectPatterns(candles) {
  if (!candles?.length || candles.length < 5) return [];

  const n = candles.length;
  const cur = candles[n - 1];
  const prev = candles[n - 2];
  const patterns = [];

  const avgBody5 =
    candles.slice(-6, -1).reduce((s, c) => s + body(c), 0) / Math.max(1, Math.min(5, n - 1));

  /* --- Engulfing --- */
  if (prev && n >= 3) {
    const pb = body(prev);
    const cb = body(cur);
    if (!isBull(prev) && isBull(cur) && cur.o <= prev.c && cur.c >= prev.o && cb >= pb * 0.95) {
      const ctx = priorTrend(candles, n - 1, 4, 'down');
      patterns.push({
        name: 'Bullish Engulfing',
        direction: 'bullish',
        strength: ctx ? 0.72 + Math.min(0.2, cb / (pb + 1e-9) * 0.05) : 0.55,
        category: 'engulfing',
        emoji: '🟢',
        tip: 'Green engulfs red → buy bias',
        description:
          'Current bullish body fully covers prior bearish body; stronger after a short downtrend.',
        reliability: 0.62,
        candleIndices: [n - 2, n - 1],
      });
    }
    if (isBull(prev) && !isBull(cur) && cur.o >= prev.c && cur.c <= prev.o && cb >= pb * 0.95) {
      const ctx = priorTrend(candles, n - 1, 4, 'up');
      patterns.push({
        name: 'Bearish Engulfing',
        direction: 'bearish',
        strength: ctx ? 0.7 : 0.52,
        category: 'engulfing',
        emoji: '🔴',
        tip: 'Red engulfs green → sell bias',
        description: 'Bearish body fully covers prior bullish body; stronger after uptrend.',
        reliability: 0.6,
        candleIndices: [n - 2, n - 1],
      });
    }
  }

  /* --- Piercing Pattern (bullish 2-candle) --- */
  if (prev && n >= 3) {
    const pb = body(prev);
    const cb = body(cur);
    if (
      !isBull(prev) && isBull(cur) &&
      cur.o < prev.l &&
      cur.c > midBody(prev) &&
      cur.c < prev.o &&
      cb > 0 && pb > 0
    ) {
      const ctx = priorTrend(candles, n - 1, 4, 'down');
      patterns.push({
        name: 'Piercing Pattern',
        direction: 'bullish',
        strength: ctx ? 0.68 : 0.50,
        category: 'piercing',
        emoji: '🔷',
        tip: 'Opens below prior low, closes above prior midpoint',
        description: 'Bullish 2-candle reversal: gap-down open then strong recovery past prior body midpoint.',
        reliability: 0.60,
        candleIndices: [n - 2, n - 1],
      });
    }
  }

  /* --- Hammer family --- */
  const r = range(cur);
  const b = body(cur);
  const uw = upperWick(cur);
  const lw = lowerWick(cur);
  if (r > 1e-9) {
    const smallBody = b < r * 0.35;
    const longLow = lw >= Math.max(b * 2, r * 0.45);
    const tinyUp = uw < r * 0.15;
    const longUp = uw >= Math.max(b * 2, r * 0.45);
    const tinyLow = lw < r * 0.15;

    if (smallBody && longLow && tinyUp && priorTrend(candles, n - 1, 5, 'down')) {
      patterns.push({
        name: 'Hammer',
        direction: 'bullish',
        strength: 0.65,
        category: 'hammer',
        emoji: '🔨',
        tip: 'Long lower wick after dip → bounce idea',
        description: 'Long lower shadow, small body at top of range — classic bullish rejection.',
        reliability: 0.58,
        candleIndices: [n - 1],
      });
    }
    if (smallBody && longUp && tinyLow && priorTrend(candles, n - 1, 5, 'down')) {
      patterns.push({
        name: 'Inverted Hammer',
        direction: 'bullish',
        strength: 0.48,
        category: 'hammer',
        emoji: '⬆️',
        tip: 'Weak bullish reversal hint',
        description: 'Upper wick after decline — buyers tried; needs confirmation.',
        reliability: 0.45,
        candleIndices: [n - 1],
      });
    }
    if (smallBody && longUp && tinyLow && priorTrend(candles, n - 1, 5, 'up')) {
      patterns.push({
        name: 'Shooting Star',
        direction: 'bearish',
        strength: 0.66,
        category: 'hammer',
        emoji: '⭐',
        tip: 'Rejection at highs',
        description: 'Long upper wick after rally — potential exhaustion.',
        reliability: 0.57,
        candleIndices: [n - 1],
      });
    }
    if (smallBody && longLow && tinyUp && priorTrend(candles, n - 1, 5, 'up')) {
      patterns.push({
        name: 'Hanging Man',
        direction: 'bearish',
        strength: 0.5,
        category: 'hammer',
        emoji: '🪢',
        tip: 'Caution at top',
        description: 'Hammer-like after uptrend — weaker bearish warning.',
        reliability: 0.48,
        candleIndices: [n - 1],
      });
    }
  }

  /* --- Morning / Evening star (3-candle) --- */
  if (n >= 3) {
    const c0 = candles[n - 3];
    const c1 = candles[n - 2];
    const c2 = candles[n - 1];
    const b0 = body(c0),
      b1 = body(c1),
      b2 = body(c2);
    const r1 = range(c1);
    if (!isBull(c0) && b0 > avgBody5 * 1.1 && b1 < r1 * 0.35 && isBull(c2) && b2 > avgBody5) {
      const mid0 = midBody(c0);
      if (c2.c > mid0) {
        patterns.push({
          name: 'Morning Star',
          direction: 'bullish',
          strength: 0.75,
          category: 'reversal',
          emoji: '🌅',
          tip: 'Three-candle bullish reversal',
          description: 'Big red, small star, strong green closing past midpoint of first candle.',
          reliability: 0.64,
          candleIndices: [n - 3, n - 2, n - 1],
        });
      }
    }
    if (isBull(c0) && b0 > avgBody5 * 1.1 && b1 < r1 * 0.35 && !isBull(c2) && b2 > avgBody5) {
      const mid0 = midBody(c0);
      if (c2.c < mid0) {
        patterns.push({
          name: 'Evening Star',
          direction: 'bearish',
          strength: 0.74,
          category: 'reversal',
          emoji: '🌆',
          tip: 'Three-candle bearish reversal',
          description: 'Big green, small body, strong red closing below midpoint of first.',
          reliability: 0.63,
          candleIndices: [n - 3, n - 2, n - 1],
        });
      }
    }
  }

  /* --- First pullback continuation --- */
  if (n >= 8) {
    const slice = candles.slice(-8, -1);
    let bullRun = 0;
    for (const c of slice.slice(0, 5)) {
      if (isBull(c)) bullRun++;
    }
    const counter = slice.slice(5, 7);
    const resume = candles[n - 1];
    if (bullRun >= 4 && counter.every((c) => !isBull(c)) && isBull(resume) && body(resume) > avgBody5 * 1.2) {
      patterns.push({
        name: 'First Pullback (Bull)',
        direction: 'bullish',
        strength: 0.58,
        category: 'pullback',
        emoji: '📈',
        tip: 'Trend resume after shallow dip',
        description: 'Strong up-leg, 1–2 red candles, strong green continuation.',
        reliability: 0.55,
        candleIndices: [n - 3, n - 2, n - 1],
      });
    }
    let bearRun = 0;
    for (const c of slice.slice(0, 5)) {
      if (!isBull(c)) bearRun++;
    }
    if (bearRun >= 4 && counter.every((c) => isBull(c)) && !isBull(resume) && body(resume) > avgBody5 * 1.2) {
      patterns.push({
        name: 'First Pullback (Bear)',
        direction: 'bearish',
        strength: 0.57,
        category: 'pullback',
        emoji: '📉',
        tip: 'Trend resume after bounce',
        description: 'Strong down-leg, small bounce, strong red continuation.',
        reliability: 0.54,
        candleIndices: [n - 3, n - 2, n - 1],
      });
    }
  }

  /* --- Liquidity sweeps --- */
  if (n >= 6) {
    const recentLow = Math.min(...candles.slice(-6, -1).map((c) => c.l));
    const recentHigh = Math.max(...candles.slice(-6, -1).map((c) => c.h));
    if (cur.l < recentLow && cur.c > recentLow && lowerWick(cur) > body(cur) * 1.2) {
      patterns.push({
        name: 'Liquidity Sweep Bullish',
        direction: 'bullish',
        strength: 0.7,
        category: 'liquidity',
        emoji: '💧',
        tip: 'Stops run under lows, close reclaimed',
        description: 'Wick below recent lows then close back above — stop-hunt reversal up.',
        reliability: 0.6,
        candleIndices: [n - 1],
      });
    }
    if (cur.h > recentHigh && cur.c < recentHigh && upperWick(cur) > body(cur) * 1.2) {
      patterns.push({
        name: 'Liquidity Sweep Bearish',
        direction: 'bearish',
        strength: 0.69,
        category: 'liquidity',
        emoji: '💧',
        tip: 'Stops above highs, failed breakout',
        description: 'Wick above recent highs then close back inside range.',
        reliability: 0.59,
        candleIndices: [n - 1],
      });
    }
  }

  /* --- Indecision: Doji and Spinning Top --- */
  let hasDoji = false;
  if (r > 1e-9) {
    // Doji: very tiny body, notable wicks on both sides
    if (b < r * 0.10 && uw > r * 0.25 && lw > r * 0.25) {
      hasDoji = true;
      patterns.push({
        name: 'Doji',
        direction: 'neutral',
        strength: 0.45,
        category: 'indecision',
        emoji: '➕',
        tip: 'Perfect indecision — open ≈ close',
        description: 'Extremely small body with wicks on both sides. Market is undecided; wait for the next candle.',
        reliability: 0.42,
        candleIndices: [n - 1],
      });
    }
    // Spinning Top: small body (but larger than doji), wicks exceed body
    if (!hasDoji && b < r * 0.30 && b >= r * 0.10 && uw > b && lw > b) {
      patterns.push({
        name: 'Spinning Top',
        direction: 'neutral',
        strength: 0.40,
        category: 'indecision',
        emoji: '🔄',
        tip: 'Weak indecision — small body, long wicks',
        description: 'Small body with notable wicks. Mild indecision; trend may continue or reverse.',
        reliability: 0.38,
        candleIndices: [n - 1],
      });
    }

    // Manipulation Candle — only if no Doji detected (Doji is more specific)
    if (!hasDoji && b < r * 0.25 && uw > r * 0.35 && lw > r * 0.35) {
      patterns.push({
        name: 'Manipulation Candle',
        direction: 'neutral',
        strength: 0.55,
        category: 'liquidity',
        emoji: '⚠️',
        tip: 'Choppy indecision — wait',
        description: 'Tiny body, long wicks both sides — liquidity grab / fake-out risk.',
        reliability: 0.4,
        candleIndices: [n - 1],
      });
    }
  }

  /* --- Momentum --- */
  if (avgBody5 > 1e-9 && b >= avgBody5 * 2.2) {
    // Detect termination risk by checking if the momentum candle shows signs of exhaustion
    let terminationRisk = 'low';
    if (n >= 2) {
      const prevCandle = candles[n - 2];
      const momDirection = isBull(cur) ? 'bullish' : 'bearish';

      // Long wick opposite to momentum direction = potential exhaustion
      if (momDirection === 'bullish' && uw > b * 0.5) terminationRisk = 'medium';
      if (momDirection === 'bearish' && lw > b * 0.5) terminationRisk = 'medium';
      if (momDirection === 'bullish' && uw > b * 0.8) terminationRisk = 'high';
      if (momDirection === 'bearish' && lw > b * 0.8) terminationRisk = 'high';

      // Declining volume on continuation
      if (prevCandle.v > 0 && cur.v < prevCandle.v * 0.7) {
        terminationRisk = terminationRisk === 'low' ? 'medium' : 'high';
      }
    }

    patterns.push({
      name: 'Momentum Candle',
      direction: isBull(cur) ? 'bullish' : 'bearish',
      strength: Math.min(0.85, 0.5 + (b / (avgBody5 * 4)) * 0.35),
      category: 'momentum',
      emoji: isBull(cur) ? '🚀' : '⬇️',
      tip: terminationRisk === 'high'
        ? 'Strong push but showing exhaustion signs'
        : terminationRisk === 'medium'
          ? 'Strong push with some caution signals'
          : 'Unusually large body — strong push',
      description: `Body much larger than recent average — directional impulse. Termination risk: ${terminationRisk}.`,
      reliability: 0.52,
      terminationRisk,
      candleIndices: [n - 1],
    });
  }

  patterns.sort((a, b) => b.strength - a.strength);
  return patterns;
}
