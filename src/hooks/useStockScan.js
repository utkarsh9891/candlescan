/**
 * useStockScan — encapsulates the main-view stock scan pipeline.
 *
 * Extracted from src/App.jsx to keep that file under the harness's
 * file-read token limit. Pure refactor: nothing about the scan
 * behaviour changes. State, effects, and callbacks moved here as-is
 * from App.jsx with only mechanical adjustments (useCallback deps,
 * consumed-from-caller values).
 *
 * The hook:
 *   - Owns all state specific to the single-stock scan pipeline
 *     (sym, candles, patterns, box, risk, quote, stockNews, loading,
 *     error, lookback, etc.)
 *   - Handles the data-source fallback chain (Zerodha → Dhan → Yahoo)
 *   - Fires the engine-specific detector/risk pipeline (scalp variants,
 *     classic, intraday)
 *   - Fires the fire-and-forget news fetch with the stale-response
 *     guard that keeps new scans from being clobbered by late
 *     responses for an older symbol
 *   - Fetches the Yahoo bid/ask quote for the detail view
 *   - Re-runs the scan on timeframe changes
 *   - Handles lazy left-edge history prefetch (Yahoo only)
 *   - Appends to the session history list
 *   - Grows the broad search universe with newly-discovered symbols
 *
 * Caller supplies the engine config (engineVersion, timeframe,
 * nseIndex) and the dataSource state + setter (so this hook can
 * switch to Yahoo when a Zerodha token expires mid-scan).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchOHLCV } from '../engine/fetcher.js';
import { fetchLiveGoogleNewsDetailForSymbol } from '../engine/marketContextLive.js';
import { classifyNewsSentiment } from '../engine/marketContext.js';
import { detectPatterns as detectPatternsClassic } from '../engine/patterns-classic.js';
import { detectLiquidityBox as detectLiquidityBoxClassic } from '../engine/liquidityBox-classic.js';
import { computeRiskScore as computeRiskScoreClassic } from '../engine/risk-classic.js';
import { detectPatterns as detectPatternsV2 } from '../engine/patterns-v2.js';
import { detectLiquidityBox as detectLiquidityBoxV2 } from '../engine/liquidityBox-v2.js';
import { computeRiskScore as computeRiskScoreV2 } from '../engine/risk-v2.js';
import { detectPatterns as detectPatternsScalp } from '../engine/patterns-scalp.js';
import { detectLiquidityBox as detectLiquidityBoxScalp } from '../engine/liquidityBox-scalp.js';
import { computeRiskScore as computeRiskScoreScalp } from '../engine/risk-scalp.js';
import { getIndexDirection } from '../engine/indexDirection.js';
import { hasVault, getVaultBlob, clearVault } from '../utils/credentialVault.js';
import { getGateToken } from '../utils/batchAuth.js';
import { fetchZerodhaOHLCV } from '../engine/zerodhaFetcher.js';
import { fetchDhanOHLCV } from '../engine/dhanFetcher.js';
import { fetchYahooQuote } from '../engine/yahooQuote.js';

export function useStockScan({
  dataSource,
  setDataSourceState,
  engineVersion,
  timeframe,
  nseIndex,
  // Passed in from useIndexUniverse so newly-discovered symbols can
  // join the broad autocomplete universe without the two hooks
  // needing duplicate state.
  onDiscoverSymbol,
}) {
  const [sym, setSym] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [loading, setLoading] = useState(false);
  const [simulated, setSimulated] = useState(false);
  const [scanError, setScanError] = useState('');
  const [candles, setCandles] = useState([]);
  const [patterns, setPatterns] = useState([]);
  const [box, setBox] = useState(null);
  const [risk, setRisk] = useState(null);
  const [lastScan, setLastScan] = useState('');
  const [yahooSym, setYahooSym] = useState('');
  const [quote, setQuote] = useState(null);
  const [lookbackLevel, setLookbackLevel] = useState(0);
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);
  const [stockNews, setStockNews] = useState(null);
  const [stockNewsLoading, setStockNewsLoading] = useState(false);
  const stockNewsReqIdRef = useRef(0);
  const activeSymRef = useRef('');

  const [zerodhaExpiredMsg, setZerodhaExpiredMsg] = useState('');
  const [lastUsedSource, setLastUsedSource] = useState('yahoo');
  const [sourceDebugReason, setSourceDebugReason] = useState('');

  // Session history (persisted by App via its own effect)
  const [history, setHistory] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('candlescan_history') || '[]');
      return Array.isArray(saved) ? saved.slice(0, 10) : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('candlescan_history', JSON.stringify(history));
    } catch { /* quota exceeded */ }
  }, [history]);

  const runScan = useCallback(async (symbol) => {
    const s = String(symbol).trim();
    if (!s) return;
    setLoading(true);
    setScanError('');
    setQuote(null);
    setZerodhaExpiredMsg('');
    setLookbackLevel(0);
    setStockNews(null);
    setStockNewsLoading(false);
    const newsReqId = ++stockNewsReqIdRef.current;
    try {
      let result;
      let usedSource = dataSource;
      let debugReason = '';

      // Try Zerodha first if configured
      if (dataSource === 'zerodha') {
        if (!hasVault()) {
          usedSource = 'yahoo';
          debugReason = `Setting=zerodha but no vault in localStorage`;
        } else {
          const vault = getVaultBlob();
          const gateToken = getGateToken();
          if (!vault || !gateToken) {
            usedSource = 'yahoo';
            debugReason = `Setting=zerodha, vault=${!!vault}, gateToken=${!!gateToken} — missing credentials`;
          } else {
            debugReason = `Setting=zerodha, vault=yes, gateToken=yes — calling Zerodha API`;
            result = await fetchZerodhaOHLCV(s, timeframe, { vault, gateToken });
            if (result.error) {
              const err = result.error;
              const isTokenExpiry = /TokenException|Incorrect.*api_key|token.*invalid|token.*expired/i.test(err);
              const isPermission = /Insufficient permission|permission denied/i.test(err);

              if (isTokenExpiry) {
                clearVault();
                try { localStorage.setItem('candlescan_data_source', 'yahoo'); } catch { /* ok */ }
                setDataSourceState('yahoo');
                setZerodhaExpiredMsg('Zerodha token expired — switched to Yahoo Finance. Reconnect in Settings.');
                debugReason += ` → token expired: ${err} → cleared vault, fallback Yahoo`;
              } else if (isPermission) {
                setZerodhaExpiredMsg('Zerodha: Historical data permission missing. Using Yahoo Finance. Enable the Historical Data add-on in your Kite Connect app.');
                debugReason += ` → permission error: ${err} → fallback Yahoo (vault kept)`;
              } else {
                debugReason += ` → error: ${err} → fallback Yahoo`;
              }
              result = null;
              usedSource = 'yahoo';
            } else {
              debugReason += ` → success (${result.candles?.length || 0} candles)`;
            }
          }
        }
      } else if (dataSource === 'dhan') {
        if (!hasVault()) {
          usedSource = 'yahoo';
          debugReason = `Setting=dhan but no vault in localStorage`;
        } else {
          const vault = getVaultBlob();
          const gateToken = getGateToken();
          if (!vault || !gateToken) {
            usedSource = 'yahoo';
            debugReason = `Setting=dhan, vault=${!!vault}, gateToken=${!!gateToken} — missing credentials`;
          } else {
            debugReason = `Setting=dhan, vault=yes, gateToken=yes — calling Dhan API`;
            result = await fetchDhanOHLCV(s, timeframe, { vault, gateToken });
            if (result.error) {
              debugReason += ` → error: ${result.error} → fallback Yahoo`;
              result = null;
              usedSource = 'yahoo';
            } else {
              debugReason += ` → success (${result.candles?.length || 0} candles)`;
            }
          }
        }
      } else {
        debugReason = `Setting=yahoo`;
      }

      // Fallback to Yahoo Finance
      if (!result || (!result.candles?.length && !result.error)) {
        if (usedSource !== 'yahoo' || !debugReason.includes('fallback')) {
          debugReason += debugReason ? ' → ' : '';
          debugReason += 'Using Yahoo Finance';
        }
        result = await fetchOHLCV(s, timeframe);
        usedSource = 'yahoo';
      }

      const { candles: cd, live: lv, simulated: sim, error: err, companyName: cn, displaySymbol, yahooSymbol } = result;

      activeSymRef.current = displaySymbol;
      setSym(displaySymbol);
      setCompanyName(cn || displaySymbol);
      setYahooSym(yahooSymbol || '');
      setSimulated(!!sim);
      setLastUsedSource(usedSource);
      setSourceDebugReason(debugReason);

      // Grow the broad search universe with newly-discovered symbols
      if (displaySymbol && cn && onDiscoverSymbol) {
        onDiscoverSymbol(displaySymbol, cn);
      }

      if (err || !cd?.length) {
        setCandles([]);
        setPatterns([]);
        setBox(null);
        setRisk(null);
        setYahooSym('');
        setScanError(err || 'No data returned.');
        setLastScan(new Date().toLocaleTimeString());
        return;
      }

      setCandles(cd);
      let detectPat, detectBox, scoreRisk;
      if (engineVersion === 'scalp') {
        detectPat = detectPatternsScalp;
        detectBox = detectLiquidityBoxScalp;
        scoreRisk = computeRiskScoreScalp;
      } else if (engineVersion === 'v1') {
        detectPat = detectPatternsClassic; detectBox = detectLiquidityBoxClassic; scoreRisk = computeRiskScoreClassic;
      } else {
        detectPat = detectPatternsV2; detectBox = detectLiquidityBoxV2; scoreRisk = computeRiskScoreV2;
      }

      // For scalp mode, fetch index direction
      let idxDir = null;
      if (engineVersion === 'scalp') {
        try { idxDir = await getIndexDirection(nseIndex); } catch { /* ignore */ }
      }

      // Compute ORB + prev day levels for pattern context (same as batchScan)
      const IST_OFFSET = 19800;
      const istDateLocal = (t) => new Date((t + IST_OFFSET) * 1000).toISOString().slice(0, 10);
      const lastDate = istDateLocal(cd[cd.length - 1].t);
      const todayCandles = cd.filter(c => istDateLocal(c.t) === lastDate);
      const prevCandles = cd.filter(c => istDateLocal(c.t) < lastDate);
      const orbBars = todayCandles.slice(0, 15);
      const orbHigh = orbBars.length >= 5 ? Math.max(...orbBars.map(c => c.h)) : null;
      const orbLow = orbBars.length >= 5 ? Math.min(...orbBars.map(c => c.l)) : null;
      const prevDayHigh = prevCandles.length ? Math.max(...prevCandles.map(c => c.h)) : null;
      const prevDayLow = prevCandles.length ? Math.min(...prevCandles.map(c => c.l)) : null;

      const pat = detectPat(cd, { barIndex: cd.length, orbHigh, orbLow, prevDayHigh, prevDayLow });
      const bx = detectBox(cd);
      const rk = scoreRisk({ candles: cd, patterns: pat, box: bx, opts: { barIndex: cd.length, indexDirection: idxDir } });
      setPatterns(pat);
      setBox(bx);
      setRisk(rk);
      setLastScan(new Date().toLocaleTimeString());

      // Fire-and-forget async news fetch (stale-response guard via newsReqId)
      setStockNewsLoading(true);
      fetchLiveGoogleNewsDetailForSymbol(displaySymbol)
        .then((res) => {
          if (newsReqId !== stockNewsReqIdRef.current) return;
          setStockNews({
            score: res.score,
            sentiment: classifyNewsSentiment(res.score),
            headlines: res.headlines || [],
          });
        })
        .catch(() => { /* silent — news is best-effort */ })
        .finally(() => {
          if (newsReqId === stockNewsReqIdRef.current) {
            setStockNewsLoading(false);
          }
        });
      setHistory((h) => {
        const next = [
          { symbol: displaySymbol, riskScore: rk.confidence },
          ...h.filter((x) => x.symbol !== displaySymbol),
        ];
        return next.slice(0, 10);
      });
    } finally {
      setLoading(false);
    }
  }, [timeframe, engineVersion, nseIndex, dataSource, setDataSourceState]);

  // Yahoo bid/ask quote for the detail view — fires after every scan
  useEffect(() => {
    if (simulated || !yahooSym || !risk) {
      setQuote(null);
      return undefined;
    }
    let cancelled = false;
    fetchYahooQuote(yahooSym).then((q) => {
      if (!cancelled) setQuote(q);
    });
    return () => { cancelled = true; };
  }, [simulated, yahooSym, risk, lastScan]);

  // Re-run the scan when the timeframe changes (preserves current symbol)
  useEffect(() => {
    if (!activeSymRef.current) return;
    runScan(activeSymRef.current);
  }, [timeframe, runScan]);

  /**
   * Lazy-prefetch more history when the user scrolls near the left edge.
   * Yahoo-only. See the explanatory comment that used to live in App.jsx.
   */
  const handleLoadMoreHistory = useCallback(async () => {
    if (lastUsedSource !== 'yahoo') return;
    if (loadingMoreHistory) return;
    if (!activeSymRef.current) return;
    const nextLevel = lookbackLevel + 1;
    setLoadingMoreHistory(true);
    try {
      const res = await fetchOHLCV(activeSymRef.current, timeframe, { lookbackLevel: nextLevel });
      if (!res?.candles?.length) return;
      const byTs = new Map();
      for (const c of candles) byTs.set(c.t, c);
      for (const c of res.candles) byTs.set(c.t, c);
      const merged = Array.from(byTs.values()).sort((a, b) => a.t - b.t);
      if (merged.length > candles.length) {
        setCandles(merged);
        setLookbackLevel(nextLevel);
      }
    } catch {
      /* silent */
    } finally {
      setLoadingMoreHistory(false);
    }
  }, [lastUsedSource, loadingMoreHistory, lookbackLevel, timeframe, candles]);

  return {
    // Identity
    sym, companyName, activeSymRef,
    // Data
    candles, patterns, box, risk,
    // Lifecycle / status
    loading, simulated, scanError, lastScan,
    // Source tracking
    yahooSym, lastUsedSource, sourceDebugReason,
    zerodhaExpiredMsg, setZerodhaExpiredMsg,
    // Quote + news
    quote, stockNews, stockNewsLoading,
    // Lazy history prefetch
    lookbackLevel, loadingMoreHistory,
    // Actions
    runScan, handleLoadMoreHistory,
    // Persistent history
    history, setHistory,
    // Raw setters exposed for callers that need them (e.g., clearing
    // results on a failed sub-action). Kept minimal.
    setCandles,
  };
}
