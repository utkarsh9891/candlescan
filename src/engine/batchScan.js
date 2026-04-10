/**
 * Batch scan — scans all stocks in an index with throttled concurrency.
 * Engine-aware: accepts detectPatterns, detectLiquidityBox, computeRiskScore
 * as parameters so the caller can select scalp/v2/classic engine.
 * Computes ORB + prev day levels per stock for pattern context.
 */

import { fetchOHLCV } from './fetcher.js';
// Fallback imports (used when engineFns not provided)
import { detectPatterns as detectPatternsDefault } from './patterns.js';
import { detectLiquidityBox as detectLiquidityBoxDefault } from './liquidityBox.js';
import { computeRiskScore as computeRiskScoreDefault } from './risk.js';

const ACTION_RANK = {
  'STRONG BUY': 5,
  'STRONG SHORT': 5,
  BUY: 4,
  SHORT: 4,
  WAIT: 2,
  'NO TRADE': 0,
};

// ─── Global rate-limit backoff ──────────────────────────────────────
// When a 429 hits, we set a "pause until" timestamp. All concurrent
// fetches in this scan check this on retry and wait until it clears.
// This prevents thundering-herd retries that immediately re-trigger 429s.
let globalPauseUntil = 0;

function triggerGlobalPause(durationMs) {
  const target = Date.now() + durationMs;
  if (target > globalPauseUntil) globalPauseUntil = target;
}

async function waitForGlobalPause(signal) {
  while (Date.now() < globalPauseUntil) {
    if (signal?.aborted) return;
    const wait = Math.min(500, globalPauseUntil - Date.now());
    if (wait <= 0) break;
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** Reset the global pause — call at the start of each new scan. */
export function resetBatchScanRateLimitState() {
  globalPauseUntil = 0;
}

const IST_OFFSET = 19800; // +5:30 in seconds
function istDate(t) {
  return new Date((t + IST_OFFSET) * 1000).toISOString().slice(0, 10);
}

/**
 * @param {Object} params
 * @param {string[]} params.symbols — list of NSE symbols (without .NS)
 * @param {string}   params.timeframe — e.g. '5m'
 * @param {string}   params.gateToken — gate token for auth (also accepts batchToken for backward compat)
 * @param {{ detectPatterns: Function, detectLiquidityBox: Function, computeRiskScore: Function }} [params.engineFns]
 * @param {{ direction: string, strength: number }} [params.indexDirection]
 * @param {number}   [params.concurrency=5]
 * @param {number}   [params.delayMs=200]
 * @param {(completed: number, total: number, current: string) => void} [params.onProgress]
 * @param {(result: Object) => void} [params.onResult] — called per-stock as results arrive (for progressive rendering)
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<Array>} sorted results
 */
export async function batchScan({
  symbols,
  timeframe,
  gateToken,
  batchToken, // backward compat
  engineFns,
  indexDirection,
  concurrency = 5,
  delayMs = 200,
  onProgress,
  onResult, // optional: called per-stock as results arrive (for progressive rendering)
  signal,
  fetchFn, // optional: custom fetch function (e.g. fetchDhanOHLCV) — defaults to Yahoo
}) {
  // Use provided engine functions or fall back to defaults
  const detectPatterns = engineFns?.detectPatterns || detectPatternsDefault;
  const detectLiquidityBox = engineFns?.detectLiquidityBox || detectLiquidityBoxDefault;
  const computeRiskScore = engineFns?.computeRiskScore || computeRiskScoreDefault;

  const results = [];
  let completed = 0;
  const total = symbols.length;

  for (let i = 0; i < total; i += concurrency) {
    if (signal?.aborted) break;

    const chunk = symbols.slice(i, i + concurrency);

    // If a previous batch hit 429, wait it out before firing the next batch.
    // This is the front-line throttle that prevents repeated 429 cascades.
    await waitForGlobalPause(signal);
    if (signal?.aborted) break;

    const settled = await Promise.allSettled(
      chunk.map(async (sym) => {
        if (signal?.aborted) return null;
        try {
          const doFetch = fetchFn || fetchOHLCV;
          let result = await doFetch(sym, timeframe, { gateToken: gateToken || batchToken });

          // Retry on 429 with exponential backoff: 2s, 5s, 15s.
          // Dhan's rate limit recovers slowly so a single short retry isn't enough.
          // Multiple retries with growing waits give the token bucket time to refill.
          const RETRY_DELAYS_MS = [2000, 5000, 15000];
          for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
            if (!result.error || !result.error.includes('429')) break;
            if (signal?.aborted) return null;
            // If global pause is engaged, wait for it to clear before retrying
            await waitForGlobalPause(signal);
            await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
            // After a 429 burst, trigger a brief global pause so other in-flight
            // requests don't keep hammering the rate-limited endpoint.
            triggerGlobalPause(RETRY_DELAYS_MS[attempt]);
            result = await doFetch(sym, timeframe, { gateToken: gateToken || batchToken });
          }

          const { candles, companyName, displaySymbol, error } = result;
          if (error || !candles?.length) return null;

          // Compute ORB + prev day levels for pattern context
          const lastDate = istDate(candles[candles.length - 1].t);
          const todayCandles = candles.filter(c => istDate(c.t) === lastDate);
          const prevCandles = candles.filter(c => istDate(c.t) < lastDate);

          const orbBars = todayCandles.slice(0, 15);
          const orbHigh = orbBars.length >= 5 ? Math.max(...orbBars.map(c => c.h)) : null;
          const orbLow = orbBars.length >= 5 ? Math.min(...orbBars.map(c => c.l)) : null;
          const prevDayHigh = prevCandles.length ? Math.max(...prevCandles.map(c => c.h)) : null;
          const prevDayLow = prevCandles.length ? Math.min(...prevCandles.map(c => c.l)) : null;

          const patterns = detectPatterns(candles, {
            barIndex: candles.length,
            orbHigh, orbLow, prevDayHigh, prevDayLow,
          });
          const box = detectLiquidityBox(candles);
          const risk = computeRiskScore({
            candles, patterns, box,
            opts: { barIndex: candles.length, indexDirection: indexDirection || null },
          });

          return {
            symbol: displaySymbol,
            companyName: companyName || displaySymbol,
            action: risk.action,
            confidence: risk.confidence,
            direction: risk.direction,
            level: risk.level,
            entry: risk.entry,
            sl: risk.sl,
            target: risk.target,
            rr: risk.rr,
            topPattern: patterns[0]?.name || 'None',
            context: risk.context,
            // Signal freshness — when the pattern fired (unix seconds) and
            // how long it remains actionable. Used to hide stale cards.
            signalBarTs: risk.signalBarTs || null,
            validTillTs: risk.validTillTs || null,
          };
        } catch {
          return null;
        }
      })
    );

    for (const r of settled) {
      completed++;
      if (r.status === 'fulfilled' && r.value) {
        results.push(r.value);
        onResult?.(r.value);
      }
    }

    onProgress?.(completed, total, chunk[chunk.length - 1] || '');

    // Throttle between batches
    if (i + concurrency < total && delayMs > 0 && !signal?.aborted) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }

  // Sort: actionable first (by rank desc), then by confidence desc
  results.sort((a, b) => {
    const ra = ACTION_RANK[a.action] || 0;
    const rb = ACTION_RANK[b.action] || 0;
    if (ra !== rb) return rb - ra;
    return b.confidence - a.confidence;
  });

  return results;
}
