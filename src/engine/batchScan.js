/**
 * Batch scan — scans all stocks in an index with throttled concurrency.
 * Engine-aware: accepts detectPatterns, detectLiquidityBox, computeRiskScore
 * as parameters so the caller can select scalp/v2/classic engine.
 * Computes ORB + prev day levels per stock for pattern context.
 */

import { fetchOHLCV } from './fetcher.js';
import { CF_WORKER_URL } from './transport.js';
// Fallback imports (used when engineFns not provided)
import { detectPatterns as detectPatternsDefault } from './patterns.js';
import { detectLiquidityBox as detectLiquidityBoxDefault } from './liquidityBox.js';
import { computeRiskScore as computeRiskScoreDefault } from './risk.js';
import { filterStock, regimeGate, rankScore, sizeMultiplier } from './tradeDecision.js';
import { classifyNewsSentiment, classifyInstitutionalFlow, liquidityTier } from './marketContext.js';
import { getSector } from './sectorMap.js';
import { fetchLiveGoogleNewsDetailForSymbol, fetchLiveYahooNewsForSymbol } from './marketContextLive.js';
import { getCachedNews, setCachedNews } from './newsCacheLocal.js';
import { isTokenExpiredError } from './brokerErrors.js';

// Per-(symbol, hour) cache for the Google News per-symbol fetches. Keeps
// us from re-hitting the Worker during back-to-back scans within the same
// hour — the CF Worker has its own KV cache layer so this is belt-and-
// braces, but it also cuts cold-start latency materially on the 2nd scan.
const NEWS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const newsCache = new Map(); // key: `${symbol}:${hour}`, value: { fetchedAt, score, headlines }

/** Exported for tests only — clears the per-symbol in-memory news cache. */
export function _resetBatchScanNewsCache() {
  newsCache.clear();
}

/** Hour bucket for cache keys. Uses local epoch hour — good enough given TTL. */
function currentHourBucket() {
  return Math.floor(Date.now() / NEWS_CACHE_TTL_MS);
}

/**
 * Tiny semaphore — used to cap concurrent per-symbol news fetches.
 * The outer scan may run with concurrency=8 (BatchScanPage, NoviceMode);
 * we keep news at most `newsConcurrency` in flight to stay well under
 * the Worker's rate-limit budget and avoid starving the chart fetches.
 */
function createSemaphore(max) {
  let active = 0;
  const queue = [];
  const drain = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const next = queue.shift();
    next();
  };
  return {
    async acquire() {
      if (active < max) {
        active++;
        return;
      }
      await new Promise((resolve) => queue.push(resolve));
    },
    release() {
      active = Math.max(0, active - 1);
      drain();
    },
  };
}

/**
 * Four-tier news fallback chain (Wave 1.5d). Never throws — on any
 * failure it returns a sentinel so the caller can fall back to the
 * index-wide Moneycontrol map. Telemetry counters are updated in place.
 *
 * Tiers, in order:
 *   1. In-memory hour cache   — fastest, scoped to this JS context.
 *   2. localStorage cache     — survives page reload; TTL 4h market / 12h off.
 *   3. Worker fetch           — reads `X-Cache` header:
 *        HIT | MISS            → fresh Google News, store in both caches.
 *        STALE                 → KV-served stale; store, mark `source: 'stale'`.
 *        UNAVAILABLE           → Worker has nothing; fall to tier 4.
 *   4. Moneycontrol fallback  — supplied by caller as `moneycontrolFn(symbol)`
 *                               or derived from the index-wide newsMap. When
 *                               present, returns `{score, source: 'moneycontrol'}`.
 *                               When missing, returns `{score: null, source: 'none'}`
 *                               so the scan continues without a news veto.
 *
 * @param {string} symbol  uppercase NSE symbol (no .NS)
 * @param {Object} opts
 * @param {Function} [opts.newsFetchFn]      override Google fetcher (tests)
 * @param {Function} [opts.yahooNewsFetchFn] override Yahoo fetcher (tests)
 * @param {Function} [opts.moneycontrolFn]   override Moneycontrol fallback (tests)
 * @param {Object} opts.telemetry            batchScan telemetry object
 * @param {Object} [opts.newsSem]            semaphore for concurrency cap
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.newsEnrichEnabled=true] when false, skip the per-symbol
 *   Worker tiers (Google + Yahoo) and rely solely on the index-wide
 *   Moneycontrol fallback. This is the below-premium path: still gets
 *   a sentiment signal for stocks the daily MC sweep happened to mention,
 *   but no per-symbol Worker calls are issued.
 * @returns {Promise<{score: number|null, headlines: Array, source: string}>}
 */
async function fetchPerSymbolNews(symbol, {
  newsFetchFn,
  yahooNewsFetchFn,
  moneycontrolFn,
  telemetry,
  newsSem,
  signal,
  newsEnrichEnabled = true,
}) {
  const none = { score: null, headlines: [], source: 'none' };
  if (!symbol) return none;
  if (signal?.aborted) return none;

  // ── Tier 1: in-memory hour cache ──────────────────────────────────
  const hour = currentHourBucket();
  const key = `${symbol}:${hour}`;
  const hit = newsCache.get(key);
  if (hit) {
    telemetry.newsCacheHits++;
    return hit;
  }

  // ── Tier 2: localStorage cache ────────────────────────────────────
  // Survives page reload; TTL-bucketed by the helper (4h/12h). Promote
  // a hit back into the in-memory cache so sibling symbols / later
  // candidates in the same scan skip the disk lookup.
  const diskHit = getCachedNews(symbol);
  if (diskHit && (diskHit.score != null || (diskHit.headlines || []).length > 0)) {
    const value = {
      score: diskHit.score,
      headlines: diskHit.headlines || [],
      source: diskHit.source || 'google',
    };
    newsCache.set(key, value);
    telemetry.newsFromCache++;
    return value;
  }

  // ── Tier 3 + 3.5: Worker fetches (Google → Yahoo) ────────────────
  // Premium-gated: when news enrichment is disabled (gate locked or user-
  // turned-off in Settings), skip the Worker calls entirely and fall
  // straight to the index-wide Moneycontrol baseline. The MC map is
  // built once at scan start and is free, so non-premium users still
  // get sentiment for stocks the daily sweep happened to mention.
  if (newsEnrichEnabled) {
    if (newsSem) await newsSem.acquire();
    try {
      if (signal?.aborted) return none;
      // Re-check in-memory cache after acquiring — a concurrent scanner
      // may have filled it while we were waiting on the semaphore.
      const hitAfter = newsCache.get(key);
      if (hitAfter) {
        telemetry.newsCacheHits++;
        return hitAfter;
      }

      const googleFetcher = newsFetchFn || fetchLiveGoogleNewsDetailForSymbol;
      const yahooFetcher = yahooNewsFetchFn || fetchLiveYahooNewsForSymbol;

      // Try Google first (tier 3). On UNAVAILABLE / empty / throw, try
      // Yahoo (tier 3.5) before falling through to MC. Yahoo recovers
      // independently when Google's RSS endpoint is throttled, and its
      // response carries native URLs + publishers — strictly better
      // headline metadata than Google when both succeed.
      let resolved = null;
      let resolvedSource = null;

      // Tier 3 — Google
      telemetry.newsFetched++;
      let gres = null;
      try {
        gres = await googleFetcher(symbol);
      } catch {
        telemetry.newsFetchErrors++;
      }
      const gStatus = String(gres?.cacheStatus || '').toUpperCase();
      if (gres && gres.score != null && gStatus !== 'UNAVAILABLE') {
        resolved = gres;
        resolvedSource = gStatus === 'STALE' ? 'stale' : 'google';
      }

      // Tier 3.5 — Yahoo (only if Google didn't resolve)
      if (!resolved) {
        telemetry.newsFetched++;
        let yres = null;
        try {
          yres = await yahooFetcher(symbol);
        } catch {
          telemetry.newsFetchErrors++;
        }
        const yStatus = String(yres?.cacheStatus || '').toUpperCase();
        if (yres && yres.score != null && yStatus !== 'UNAVAILABLE') {
          resolved = yres;
          resolvedSource = yStatus === 'STALE' ? 'stale-yahoo' : 'yahoo';
        }
      }

      if (resolved) {
        const value = {
          score: resolved.score,
          headlines: resolved.headlines || [],
          source: resolvedSource,
        };
        newsCache.set(key, value);
        if (newsCache.size > 4096) {
          const firstKey = newsCache.keys().next().value;
          if (firstKey !== undefined) newsCache.delete(firstKey);
        }
        // Persist only fresh results — STALE entries get served to the
        // current scan but not re-cached, so the next scan refetches
        // once upstream recovers.
        if (resolvedSource === 'google' || resolvedSource === 'yahoo') {
          setCachedNews(symbol, { ...value });
        }
        return value;
      }
      // Both tiers UNAVAILABLE / empty — fall through to tier 4 below.
    } finally {
      if (newsSem) newsSem.release();
    }
  }

  // ── Tier 4: Moneycontrol baseline ─────────────────────────────────
  // Always available, no auth required. The cheap free path — index-wide
  // RSS map, string-matched to the symbol. Imperfect (matches by company
  // name / symbol literal in the headline) but free, and the only
  // sentiment source available below the premium gate.
  try {
    if (moneycontrolFn) {
      const mc = await moneycontrolFn(symbol);
      if (mc && mc.score != null) {
        telemetry.newsFromFallback++;
        return {
          score: mc.score,
          headlines: mc.headlines || [],
          source: 'moneycontrol',
        };
      }
    }
  } catch {
    // Moneycontrol fallback never throws into the scan — silently
    // coalesce into the "unavailable" branch below.
  }

  // No news at any tier — scan continues without a sentiment signal.
  telemetry.newsUnavailable++;
  return none;
}

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

// ── FII/DII flow cache ───────────────────────────────────────────────
// FII/DII net values are published once per day after the 5pm NSE
// cutoff, so intraday fetches within the same date are guaranteed
// identical. A 10-minute TTL keyed by the IST date means the first
// scan of the day hits the Worker and subsequent scans within the
// same 10-minute window reuse the classification without a network
// call. Past the TTL we refetch in case the day has rolled over or
// NSE finally posted previously-delayed data. Concurrent scans share
// a single in-flight promise to guarantee only one network round trip
// even when two scans fire at the same instant.
const FLOW_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const flowCache = { date: null, flow: null, fetchedAt: 0 };
let inflightFlowFetch = null; // Promise<string> | null — coalesces concurrent callers

/** Exported for tests only — clears the module-level FII/DII flow cache. */
export function _resetBatchScanFlowCache() {
  flowCache.date = null;
  flowCache.flow = null;
  flowCache.fetchedAt = 0;
  inflightFlowFetch = null;
}

/** IST-aware date stamp (YYYY-MM-DD). FII/DII cutoff is 5pm IST. */
function todayIstDate() {
  const nowMs = Date.now() + IST_OFFSET * 1000;
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Fetch today's FII/DII classification from the CF Worker's
 * `/market/fiidii` endpoint. Never throws — on any failure
 * (network error, 404/5xx, malformed body, missing fields) it logs
 * a `console.warn` and returns `'NEUTRAL'` so the caller can proceed
 * without a crash. FII/DII data is occasionally delayed by NSE, so
 * a missing value is not an error — it just means no flow signal.
 *
 * Results are cached in-memory for 10 minutes keyed by the IST date,
 * and concurrent callers share a single in-flight promise so the
 * Worker only sees one request per cache miss.
 *
 * @param {Object} [opts]
 * @param {Function} [opts.fetchFn] override global fetch (tests)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string>} one of the `classifyInstitutionalFlow`
 *   outputs (`STRONG_BUY` | `BUY` | `NEUTRAL` | `SELL` | `STRONG_SELL`),
 *   defaulting to `'NEUTRAL'` when the endpoint / classification fails.
 */
export async function fetchFlowClass({ fetchFn, signal } = {}) {
  const today = todayIstDate();
  const age = Date.now() - flowCache.fetchedAt;
  if (flowCache.date === today && flowCache.flow && age < FLOW_CACHE_TTL_MS) {
    return flowCache.flow;
  }
  // Share an in-flight fetch between concurrent scans so the Worker
  // receives exactly one request even when N callers race the cache.
  if (inflightFlowFetch) return inflightFlowFetch;
  inflightFlowFetch = (async () => {
    try {
      const f = fetchFn || (typeof globalThis !== 'undefined' ? globalThis.fetch : null);
      if (!f) {
        // eslint-disable-next-line no-console
        console.warn('[batchScan] fetchFlowClass: no fetch implementation available; defaulting to NEUTRAL');
        return 'NEUTRAL';
      }
      const res = await f(`${CF_WORKER_URL}/market/fiidii`, {
        headers: { Accept: 'application/json' },
        signal,
      });
      if (!res || !res.ok) {
        // eslint-disable-next-line no-console
        console.warn(`[batchScan] FII/DII endpoint returned ${res?.status ?? 'no response'} — defaulting flow to NEUTRAL`);
        return 'NEUTRAL';
      }
      const data = await res.json();
      const classified = classifyInstitutionalFlow(data?.fii, data?.dii);
      if (!classified) {
        // eslint-disable-next-line no-console
        console.warn('[batchScan] FII/DII endpoint returned empty/unclassifiable values — defaulting flow to NEUTRAL');
        return 'NEUTRAL';
      }
      flowCache.date = today;
      flowCache.flow = classified;
      flowCache.fetchedAt = Date.now();
      return classified;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[batchScan] FII/DII fetch failed: ${err?.message || err} — defaulting flow to NEUTRAL`);
      return 'NEUTRAL';
    } finally {
      inflightFlowFetch = null;
    }
  })();
  return inflightFlowFetch;
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
  marketContext, // { vixRegime, flow, newsMap, vix, fii, dii, ... } from marketContextLive
  concurrency = 5,
  delayMs = 200,
  onProgress,
  onResult, // optional: called per-stock as results arrive (for progressive rendering)
  signal,
  fetchFn, // optional: custom fetch function (e.g. fetchDhanOHLCV) — defaults to Yahoo
  newsFetchFn, // optional: override for per-symbol Google news fetch (tests)
  yahooNewsFetchFn, // optional: override for per-symbol Yahoo news fetch (tests)
  newsConcurrency = 6, // cap on parallel per-symbol news fetches (Worker rate-limit)
  moneycontrolFn, // optional: tier-4 fallback used when the Worker is UNAVAILABLE (tests)
  flowFetchFn, // optional: override for the CF Worker fetch inside fetchFlowClass (tests)
  newsEnrichEnabled = true, // when false, skip per-symbol Worker news tiers (premium gate locked)
}) {
  // Use provided engine functions or fall back to defaults
  const detectPatterns = engineFns?.detectPatterns || detectPatternsDefault;
  const detectLiquidityBox = engineFns?.detectLiquidityBox || detectLiquidityBoxDefault;
  const computeRiskScore = engineFns?.computeRiskScore || computeRiskScoreDefault;
  // Optional: proximity detector for Novice Mode watch list. When supplied,
  // each result gets a `proximityInfo` field attached. Silently skipped
  // when omitted so regular batch/simulation callers are unaffected.
  const detectProximity = engineFns?.detectProximity || null;

  const results = [];
  let completed = 0;
  const total = symbols.length;
  // Token-expiry short-circuit. The first symbol that surfaces a
  // TokenExpiredError wins; subsequent fetches in the same chunk can
  // still throw but we only latch the first broker so the UI gets a
  // single stable banner. Outer loop bails after the current chunk.
  let tokenError = null;

  // Shared semaphore across the whole scan caps per-symbol news fetches
  // at newsConcurrency even when the outer scan uses a wider chunk size.
  const newsSem = createSemaphore(Math.max(1, newsConcurrency));

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
    // Per-symbol news fetches (Phase A P1 #7). `newsFetched` counts the
    // Worker calls we actually made; `newsCacheHits` counts candidates
    // that resolved from the per-(symbol, hour) cache with no network call.
    newsFetched: 0,
    newsCacheHits: 0,
    newsFetchErrors: 0,
    // Wave 1.5d telemetry — the 4-tier news fallback chain.
    // `newsFromCache` counts localStorage hits (tier 2).
    // `newsFromFallback` counts Moneycontrol tier-4 resolutions when
    //   the Worker reported UNAVAILABLE or the fetcher errored.
    // `newsUnavailable` counts candidates that ended with score=null
    //   at every tier — the scan proceeds without a news veto for them.
    newsFromCache: 0,
    newsFromFallback: 0,
    newsUnavailable: 0,
    // FII/DII flow (P1 #6 follow-up). `flowClass` is the classification
    // string consumed by sizeMultiplier; `flowSource` tells the dev
    // console whether it came from the caller's pre-fetched marketContext,
    // the scan-start Worker fetch, or the NEUTRAL fallback.
    flowClass: null,
    flowSource: null,
    concurrency,
    delayMs,
  };

  // ── Live FII/DII flow ────────────────────────────────────────────
  // Prefer the pre-fetched value from `marketContext` when the caller
  // supplied one (BatchScanPage, NoviceMode), otherwise fire a single
  // Worker call at scan start and reuse its result for every symbol.
  // Callers that rely on the cached/inflight behaviour include the
  // paper-trading page and the scheduled-check hook — they previously
  // passed `flow: null` end-to-end, so sizeMultiplier fell through to
  // the no-flow path. `fetchFlowClass` never throws and returns
  // `'NEUTRAL'` on any failure, so the scan is robust to CF Worker
  // hiccups or NSE delays.
  let flowClass = marketContext?.flow || null;
  let flowSource = flowClass ? 'marketContext' : null;
  if (!flowClass && !signal?.aborted) {
    flowClass = await fetchFlowClass({ fetchFn: flowFetchFn, signal });
    // If the cache was populated by this call (or an earlier one today)
    // the fetch succeeded; otherwise we're on the NEUTRAL fallback.
    flowSource = flowCache.flow === flowClass ? 'worker' : 'fallback';
  }
  telemetry.flowClass = flowClass;
  telemetry.flowSource = flowSource;

  for (let i = 0; i < total; i += concurrency) {
    if (signal?.aborted) break;
    // Short-circuit once a broker token is confirmed expired —
    // every subsequent fetch would just fail the same way and the
    // UI already has what it needs to prompt a reconnect.
    if (tokenError) break;

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

          // ── Build per-stock market context ──
          // Mixes live market context (VIX, flow, news map) with
          // per-stock derived values (sector, news sentiment, liquidity).
          const cleanSym = String(displaySymbol).toUpperCase().replace(/\.NS$/, '');
          // Index-wide Moneycontrol map — used as the fallback when the
          // per-symbol Google News fetch fails or returns nothing.
          const indexNewsScore = marketContext?.newsMap?.[cleanSym] ?? null;
          let newsScore = indexNewsScore;
          let sentiment = classifyNewsSentiment(newsScore);
          // Headlines that drove this symbol's sentiment — surfaced in UI
          // so the trader can see WHY the news layer said bullish/bearish.
          let headlines = marketContext?.headlinesMap?.[cleanSym] || [];
          let newsSource = indexNewsScore != null ? 'moneycontrol' : null;
          // Liquidity tier from the average bar volume over recent trading
          const recentVols = candles.slice(-60).map((c) => c.v || 0);
          const avgPerBarVol = recentVols.length
            ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length
            : 0;
          const liquidity = liquidityTier(avgPerBarVol);
          const stockContext = {
            vixRegime: marketContext?.vixRegime || null,
            // `flowClass` is hydrated once at scan start (either from the
            // caller's marketContext or the Worker), so every symbol sees
            // the same institutional-flow signal. Defaults to 'NEUTRAL'
            // if the endpoint failed.
            flow: flowClass,
            liquidity,
            sentiment,
            // sector is informational only — tradeDecision.js doesn't gate on it
          };

          // ── PHASE 1: pre-pattern filter ──
          const filterRes = filterStock({ symbol: cleanSym }, stockContext);
          if (!filterRes.ok) return { filterRejected: filterRes.reason, symbol: displaySymbol };

          // ── PHASE 2a: pattern detection + risk ──
          const patterns = detectPatterns(candles, {
            barIndex: candles.length,
            orbHigh, orbLow, prevDayHigh, prevDayLow,
            indexDirection: indexDirection || null,
          });
          const box = detectLiquidityBox(candles);
          const risk = computeRiskScore({
            candles, patterns, box,
            opts: { barIndex: candles.length, indexDirection: indexDirection || null, sym: cleanSym },
          });

          // ── PHASE 2a.5: per-symbol news enrichment (candidates only) ──
          // Only symbols that actually produced a tradeable signal get a
          // per-symbol Google News fetch. That keeps Worker traffic to
          // the ~5% of the universe that matters, vs hitting every symbol.
          //
          // Full 4-tier fallback chain lives in fetchPerSymbolNews:
          //   in-memory → localStorage → Worker (HIT/STALE/UNAVAILABLE)
          //             → Moneycontrol (below, auto-derived from the
          //               caller's marketContext when not explicitly
          //               injected via `moneycontrolFn`).
          const isCandidate = risk.direction && risk.action && risk.action !== 'NO TRADE';
          if (isCandidate) {
            // Auto-build the tier-4 fallback from the index-wide newsMap
            // when the caller didn't inject a test override. The closure
            // captures `indexNewsScore` + `headlines` which were already
            // computed above from the index-wide marketContext.
            const mcFn = moneycontrolFn || (indexNewsScore != null
              ? async () => ({ score: indexNewsScore, headlines })
              : null);
            const enrich = await fetchPerSymbolNews(cleanSym, {
              newsFetchFn, yahooNewsFetchFn, moneycontrolFn: mcFn,
              telemetry, newsSem, signal, newsEnrichEnabled,
            });
            if (enrich && enrich.score != null) {
              if (enrich.source === 'moneycontrol') {
                // Tier-4 fell back to Moneycontrol. Use its score
                // directly; it already reflects the index-wide signal.
                newsScore = enrich.score;
                newsSource = 'moneycontrol';
                if (enrich.headlines?.length) headlines = enrich.headlines;
              } else {
                // Per-symbol Worker tier (Google or Yahoo, fresh or stale)
                // wins over the index-wide MC signal; if both exist we
                // average them (matches enrichWithGoogleNews semantics in
                // marketContextLive.js).
                newsScore = indexNewsScore != null
                  ? (indexNewsScore + enrich.score) / 2
                  : enrich.score;
                if (enrich.headlines?.length) {
                  headlines = enrich.headlines;
                }
                // `source` propagates which tier resolved: 'google',
                // 'yahoo', 'stale', 'stale-yahoo', or 'both' when blended
                // with the index map.
                const baseSource = enrich.source || 'google';
                newsSource = indexNewsScore != null ? 'both' : baseSource;
              }
              sentiment = classifyNewsSentiment(newsScore);
              stockContext.sentiment = sentiment;
            }
          }

          // ── PHASE 2b: regime gate (post-pattern) ──
          const gateRes = regimeGate(risk.direction, stockContext);
          const gated = !gateRes.ok;

          // ── PHASE 3a: rank score (per-stock signals only) ──
          const score = rankScore(risk, stockContext);

          // ── PHASE 4: size multiplier (day-level → exposure) ──
          const sizeRes = sizeMultiplier(stockContext, { direction: risk.direction });

          // ── OPTIONAL: proximity detection for Novice Mode ──
          // Computed on the same candles we already fetched — no extra
          // network calls. Skipped entirely when the caller didn't ask
          // for it (detectProximity is null), which is the common case.
          let proximityInfo = null;
          if (detectProximity) {
            try {
              proximityInfo = detectProximity(candles, {
                barIndex: candles.length,
                indexDirection: indexDirection || null,
              });
            } catch {
              /* proximity is best-effort — never break the scan */
            }
          }

          return {
            symbol: displaySymbol,
            companyName: companyName || displaySymbol,
            // If the regime gate rejects (e.g. counter-strong news), override
            // the action to NO TRADE so the UI doesn't offer it.
            action: gated ? 'NO TRADE' : risk.action,
            confidence: risk.confidence,
            rankScore: score,
            sizeMult: sizeRes.mult,
            direction: risk.direction,
            level: gated ? 'low' : risk.level,
            entry: risk.entry,
            sl: risk.sl,
            target: risk.target,
            rr: risk.rr,
            topPattern: patterns[0]?.name || 'None',
            context: risk.context,
            signalBarTs: risk.signalBarTs || null,
            validTillTs: risk.validTillTs || null,
            // Expose per-stock context for UI / debug
            newsSentiment: sentiment,
            newsScore: newsScore,
            newsHeadlines: headlines,
            newsSource,
            vixRegime: stockContext.vixRegime,
            flow: stockContext.flow,
            liquidity,
            gatedReason: gated ? gateRes.reason : null,
            sector: getSector(cleanSym),
            // Optional — only populated when the caller provided a
            // detectProximity fn (Novice Mode). Shape is the return
            // object of detectProximity or null.
            proximityInfo,
          };
        } catch (err) {
          // Token-expiry is the ONE error we never swallow — it means
          // every other symbol in this scan will also fail, and the
          // user needs to know to reconnect. Latch it on the outer
          // tokenError so the main loop can short-circuit and the
          // caller can render a banner.
          if (isTokenExpiredError(err)) {
            if (!tokenError) tokenError = { broker: err.broker };
            return null;
          }
          // All other errors stay soft-failed so one bad symbol
          // doesn't kill the entire index scan.
          return null;
        }
      })
    );

    for (const r of settled) {
      completed++;
      telemetry.symbolsScanned++;
      if (r.status === 'fulfilled' && r.value) {
        // Skip results that were rejected at phase 1 (filter)
        if (r.value.filterRejected) continue;
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

  // Sort: actionable first (by action rank desc), then by rank score desc.
  // rankScore includes per-stock signals (news bonus) beyond raw confidence,
  // so sorting by it reflects the true trade-decision ordering.
  results.sort((a, b) => {
    const ra = ACTION_RANK[a.action] || 0;
    const rb = ACTION_RANK[b.action] || 0;
    if (ra !== rb) return rb - ra;
    const sa = a.rankScore != null ? a.rankScore : a.confidence;
    const sb = b.rankScore != null ? b.rankScore : b.confidence;
    return sb - sa;
  });

  // Finalize telemetry
  telemetry.endTs = Date.now();
  telemetry.totalMs = telemetry.endTs - telemetry.startTs;
  telemetry.aborted = !!signal?.aborted;
  telemetry.tokenExpired = tokenError ? tokenError.broker : null;

  // Return results array (preserving the existing API) with non-enumerable
  // `telemetry` + `tokenError` properties attached so callers that
  // destructure as an array still work. Callers that want the banner
  // signal read results.tokenError (null when every fetch succeeded).
  Object.defineProperty(results, 'telemetry', {
    value: telemetry,
    enumerable: false,
  });
  Object.defineProperty(results, 'tokenError', {
    value: tokenError, // { broker: 'dhan' | 'kite' } | null
    enumerable: false,
  });
  return results;
}
