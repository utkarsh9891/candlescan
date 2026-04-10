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

/**
 * No-op kept for API compatibility — earlier versions used a global pause
 * coordinator that ended up serializing scans. We removed it because the
 * user wants per-request retries only, never blocking unrelated requests.
 */
export function resetBatchScanRateLimitState() {
  // intentionally empty
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

  // ── Telemetry ────────────────────────────────────────────────────
  // Tracked for the lifetime of this scan and surfaced via the
  // returned `telemetry` field. Keeps the engine honest about its
  // own perf and lets the UI show meaningful diagnostics.
  const telemetry = {
    startTs: Date.now(),
    endTs: 0,
    totalMs: 0,
    symbolsRequested: total,
    symbolsScanned: 0,
    symbolsWithCandles: 0,
    symbolsActionable: 0,
    symbolsErrored: 0,
    fetchCalls: 0,         // total fetch invocations (incl. retries)
    fetchErrors: 0,        // any non-429 fetch failures
    rateLimitHits: 0,      // count of 429 responses
    retriesPerformed: 0,   // count of retry attempts
    retriesRecovered: 0,   // retries that ultimately succeeded
    retriesFailed: 0,      // retries that gave up after max attempts
    concurrency,
    delayMs,
  };

  for (let i = 0; i < total; i += concurrency) {
    if (signal?.aborted) break;

    const chunk = symbols.slice(i, i + concurrency);

    const settled = await Promise.allSettled(
      chunk.map(async (sym) => {
        if (signal?.aborted) return null;
        try {
          const doFetch = fetchFn || fetchOHLCV;
          telemetry.fetchCalls++;
          let result = await doFetch(sym, timeframe, { gateToken: gateToken || batchToken });

          // Retry ONLY the failed request with short, local backoff.
          // No global coordinator — other in-flight requests keep flowing.
          // Backoffs: 1s → 2s → 4s. Most 429s recover within the first 1s
          // because Dhan's token bucket refills in <1s and only the
          // unlucky few who hit the exact limit need to wait.
          const RETRY_DELAYS_MS = [1000, 2000, 4000];
          let recovered = false;
          for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
            if (!result.error || !result.error.includes('429')) break;
            if (signal?.aborted) return null;
            telemetry.rateLimitHits++;
            telemetry.retriesPerformed++;
            await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
            telemetry.fetchCalls++;
            result = await doFetch(sym, timeframe, { gateToken: gateToken || batchToken });
            if (!result.error || !result.error.includes('429')) {
              recovered = true;
              telemetry.retriesRecovered++;
              break;
            }
          }
          // If still 429 after all retries, count as a failed retry
          if (result.error && result.error.includes('429') && !recovered) {
            telemetry.retriesFailed++;
          }

          const { candles, companyName, displaySymbol, error } = result;
          if (error) telemetry.fetchErrors++;
          if (error || !candles?.length) return null;
          telemetry.symbolsWithCandles++;

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
      telemetry.symbolsScanned++;
      if (r.status === 'fulfilled' && r.value) {
        results.push(r.value);
        if (r.value.action && r.value.action !== 'NO TRADE' && r.value.action !== 'WAIT') {
          telemetry.symbolsActionable++;
        }
        onResult?.(r.value);
      } else if (r.status === 'rejected') {
        telemetry.symbolsErrored++;
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

  // Finalize telemetry
  telemetry.endTs = Date.now();
  telemetry.totalMs = telemetry.endTs - telemetry.startTs;
  telemetry.aborted = !!signal?.aborted;

  // Return results array (preserving the existing API) with a non-enumerable
  // `telemetry` property attached so callers that destructure as an array
  // still work. Callers that want the metrics can read results.telemetry.
  Object.defineProperty(results, 'telemetry', {
    value: telemetry,
    enumerable: false,
  });
  return results;
}
