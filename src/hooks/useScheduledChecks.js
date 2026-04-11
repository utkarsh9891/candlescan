/**
 * useScheduledChecks — global "check this stock again at time T" registry.
 *
 * Used by both Novice Mode (for watch-list cards like "Close to firing a
 * BUY — check in a minute") and expert Index Scanner (for WAIT / near-
 * threshold result cards). Lives at App.jsx level so schedules persist
 * across view navigation.
 *
 * How it works:
 *
 *   1. Any card anywhere in the app can call `schedule(symbol, opts)` to
 *      queue a future check. The card passes the current "before"
 *      classification so we can tell whether the stock converted when
 *      the timer fires.
 *
 *   2. A single polling loop (every 2 s) scans for schedules whose
 *      scheduledAt timestamp has passed and whose status is still
 *      'pending'. For each ripe schedule it:
 *        a. Marks status 'running'.
 *        b. Runs a single-symbol batchScan using the scalp engine +
 *           proximity detector (same pipeline Novice Mode uses for
 *           its auto-refresh).
 *        c. Compares the result's classification (trade-now / imminent
 *           / building / early / ignore) against the "before" snapshot
 *           and marks `converted: true` iff we went from a non-trade
 *           classification to 'trade-now'.
 *        d. Stores the result on the schedule and flips status 'done'.
 *
 *   3. `dismiss(id)` removes a schedule from the list (both pending
 *      and completed ones).
 *
 * State-persistence choice: in-memory only. Schedules are short-lived
 * (60-240 s) and have no value across page reloads. localStorage
 * persistence would complicate timer restoration on mount and pollute
 * storage. If we want survive-reload later, add it as a layer.
 *
 * indexDirection + marketContext are fetched FRESH at fire time. Both
 * are cheap: getIndexDirection caches for 5 minutes internally and
 * fetchLiveMarketContext caches per day. This avoids stale snapshots
 * from the schedule-time context.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { batchScan } from '../engine/batchScan.js';
import { detectPatterns as detectPatternsScalp } from '../engine/patterns-scalp.js';
import { detectLiquidityBox as detectLiquidityBoxScalp } from '../engine/liquidityBox-scalp.js';
import { computeRiskScore as computeRiskScoreScalp } from '../engine/risk-scalp.js';
import { detectProximity, classifyForNovice } from '../engine/proximity-scalp.js';
import { getIndexDirection } from '../engine/indexDirection.js';
import { fetchLiveMarketContext } from '../engine/marketContextLive.js';
import { createFetchFn } from '../engine/dataSourceFetch.js';
import { getGateToken, hasGateToken } from '../utils/batchAuth.js';

const SCALP_ENGINE_FNS = {
  detectPatterns: detectPatternsScalp,
  detectLiquidityBox: detectLiquidityBoxScalp,
  computeRiskScore: computeRiskScoreScalp,
  detectProximity,
};

// Poll cadence. 2 s is fine — we're just scanning an in-memory list.
const POLL_MS = 2000;

// Default durations per tier when the caller doesn't specify.
export const DEFAULT_DURATIONS_MS = {
  imminent: 60 * 1000,      // 1 min
  building: 2 * 60 * 1000,  // 2 min
  early:    4 * 60 * 1000,  // 4 min
  // Expert path: "WAIT" cards with confidence 60-74 behave like imminent
  wait:     60 * 1000,
};

let _idCounter = 1;
function nextId() { return `sch_${Date.now()}_${_idCounter++}`; }

/**
 * @param {Object} params
 * @param {string} params.dataSource
 * @param {string} params.nseIndex — used to resolve indexDirection at fire time
 */
export function useScheduledChecks({ dataSource, nseIndex }) {
  const [checks, setChecks] = useState([]);
  const checksRef = useRef(checks);
  checksRef.current = checks;

  // Keep latest dataSource + nseIndex accessible inside the interval
  // without re-creating the interval on every change.
  const configRef = useRef({ dataSource, nseIndex });
  configRef.current = { dataSource, nseIndex };

  /**
   * Schedule a check.
   * @param {Object} opts
   * @param {string} opts.symbol
   * @param {string} [opts.company] — display name for the panel
   * @param {'long'|'short'} [opts.direction]
   * @param {'trade-now'|'imminent'|'building'|'early'|'wait'|'ignore'} [opts.beforeClass]
   * @param {string} [opts.beforeHint] — plain-english line saved for display
   * @param {number} [opts.durationMs] — override the tier default
   * @param {string} [opts.tier] — 'imminent' | 'building' | 'early' | 'wait'
   * @returns {string} schedule id
   */
  const schedule = useCallback((opts) => {
    const {
      symbol,
      company,
      direction,
      beforeClass,
      beforeHint,
      durationMs,
      tier = 'imminent',
    } = opts || {};
    if (!symbol) return null;

    // Prevent duplicate pending schedules for the same symbol — replace
    // the existing pending one with the new duration.
    const now = Date.now();
    const ms = durationMs || DEFAULT_DURATIONS_MS[tier] || DEFAULT_DURATIONS_MS.imminent;
    const id = nextId();
    const entry = {
      id,
      symbol,
      company: company || symbol,
      direction: direction || null,
      beforeClass: beforeClass || null,
      beforeHint: beforeHint || '',
      tier,
      createdAt: now,
      scheduledAt: now + ms,
      status: 'pending',        // 'pending' | 'running' | 'done' | 'error'
      result: null,
      converted: null,
      errorMsg: null,
    };

    setChecks(prev => {
      // Drop any prior pending schedule for the same symbol.
      const withoutDupe = prev.filter(c => !(c.symbol === symbol && c.status === 'pending'));
      return [entry, ...withoutDupe];
    });
    return id;
  }, []);

  const dismiss = useCallback((id) => {
    setChecks(prev => prev.filter(c => c.id !== id));
  }, []);

  const dismissAllDone = useCallback(() => {
    setChecks(prev => prev.filter(c => c.status !== 'done' && c.status !== 'error'));
  }, []);

  /**
   * Run the actual check for a single schedule. Called from the polling
   * loop when scheduledAt <= now. Sets status → running → done.
   */
  const fireCheck = useCallback(async (id) => {
    // Mark running
    setChecks(prev => prev.map(c => c.id === id ? { ...c, status: 'running' } : c));
    const current = checksRef.current.find(c => c.id === id);
    if (!current) return;

    try {
      const { dataSource: ds, nseIndex: idx } = configRef.current;
      if (!hasGateToken()) {
        throw new Error('Unlock scanning first (set passphrase in Index Scanner).');
      }
      const token = getGateToken();

      let indexDirection = null;
      try { indexDirection = await getIndexDirection(idx); } catch { /* ok */ }

      let marketContext = null;
      try {
        marketContext = await fetchLiveMarketContext(new Set([current.symbol.toUpperCase().replace(/\.NS$/, '')]));
      } catch { /* ok */ }

      const results = await batchScan({
        symbols: [current.symbol],
        timeframe: '1m',
        gateToken: token,
        engineFns: SCALP_ENGINE_FNS,
        indexDirection,
        marketContext,
        concurrency: 1,
        delayMs: 0,
        fetchFn: createFetchFn(ds || 'yahoo'),
      });

      const r = results?.[0] || null;
      const afterClass = r ? classifyForNovice(r, r.proximityInfo) : 'ignore';
      const wasTrade = current.beforeClass === 'trade-now';
      const isTrade = afterClass === 'trade-now';
      // Converted = went from non-actionable to actionable. (We don't
      // surface a "dropped back" warning explicitly — the status copy
      // handles both.)
      const converted = !wasTrade && isTrade;

      setChecks(prev => prev.map(c => c.id === id ? {
        ...c,
        status: 'done',
        firedAt: Date.now(),
        result: r,
        afterClass,
        converted,
      } : c));
    } catch (e) {
      setChecks(prev => prev.map(c => c.id === id ? {
        ...c,
        status: 'error',
        firedAt: Date.now(),
        errorMsg: e?.message || String(e),
      } : c));
    }
  }, []);

  // Polling loop — looks for ripe schedules and fires them.
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const ripe = checksRef.current.filter(c => c.status === 'pending' && c.scheduledAt <= now);
      for (const c of ripe) {
        fireCheck(c.id);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [fireCheck]);

  return {
    checks,
    schedule,
    dismiss,
    dismissAllDone,
  };
}
