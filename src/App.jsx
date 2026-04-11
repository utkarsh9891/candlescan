import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { fetchOHLCV } from './engine/fetcher.js';
import { fetchLiveGoogleNewsDetailForSymbol } from './engine/marketContextLive.js';
import { classifyNewsSentiment } from './engine/marketContext.js';
import { detectPatterns as detectPatternsClassic } from './engine/patterns-classic.js';
import { detectLiquidityBox as detectLiquidityBoxClassic } from './engine/liquidityBox-classic.js';
import { computeRiskScore as computeRiskScoreClassic } from './engine/risk-classic.js';
import { detectPatterns as detectPatternsV2 } from './engine/patterns-v2.js';
import { detectLiquidityBox as detectLiquidityBoxV2 } from './engine/liquidityBox-v2.js';
import { computeRiskScore as computeRiskScoreV2 } from './engine/risk-v2.js';
import { detectPatterns as detectPatternsScalp } from './engine/patterns-scalp.js';
import { detectLiquidityBox as detectLiquidityBoxScalp } from './engine/liquidityBox-scalp.js';
import { computeRiskScore as computeRiskScoreScalp } from './engine/risk-scalp.js';
import { getScalpVariantFns, DEFAULT_SCALP_VARIANT } from './engine/scalp-variants/registry.js';
import { getIndexDirection } from './engine/indexDirection.js';
import Header from './components/Header.jsx';
import TimeframePills, { SOURCE_TIMEFRAMES } from './components/TimeframePills.jsx';
import SearchBar from './components/SearchBar.jsx';
import Chart from './components/Chart.jsx';
import EmptyState from './components/EmptyState.jsx';
import AdvancedView from './components/AdvancedView.jsx';
import ToggleSwitch from './components/ToggleSwitch.jsx';
import GlobalMenu from './components/GlobalMenu.jsx';
import DrawingToolbar from './components/DrawingToolbar.jsx';
import IndexConstituentsSidebar from './components/IndexConstituentsSidebar.jsx';
import BatchScanPage from './components/BatchScanPage.jsx';
import SimulationPage from './components/SimulationPage.jsx';
import PaperTradingPage from './components/PaperTradingPage.jsx';
import NoviceModePage from './components/NoviceModePage.jsx';
import SettingsPage from './components/SettingsPage.jsx';
import DebugPanel from './components/DebugPanel.jsx';
import UpdatePrompt from './components/UpdatePrompt.jsx';
import { getMarketStatus } from './utils/marketHours.js';
import { NSE_INDEX_OPTIONS, DEFAULT_NSE_INDEX_ID, getCustomIndices, addCustomIndex, removeCustomIndex, getAllIndexOptions, getBuiltInIndexOptions } from './config/nseIndices.js';
import { hasGateToken, getGateToken } from './utils/batchAuth.js';
import { getVaultBlob, hasVault, clearVault } from './utils/credentialVault.js';
import { fetchZerodhaOHLCV } from './engine/zerodhaFetcher.js';
import { fetchDhanOHLCV } from './engine/dhanFetcher.js';
import { SIGNAL_CATEGORIES, APPROX_PATTERN_RULES, getCategoriesForEngine, getRuleCountForEngine } from './data/signalCategories.js';
import { fetchNseIndexSymbolList, fetchNseIndexWithNames } from './engine/nseIndexFetch.js';
import { fetchYahooQuote } from './engine/yahooQuote.js';
import { isDynamicIndex } from './data/dynamicIndices.js';

function DataDelayDisclaimer({ candles, simulated, dataSource, lastScan }) {
  const sourceName = dataSource === 'zerodha' ? 'Zerodha Kite' : dataSource === 'dhan' ? 'Dhan' : 'Yahoo Finance';
  const status = getMarketStatus();
  const showDelay = !simulated && candles?.length > 0 && status.isOpen;

  // Only show during market hours when data may be delayed
  const lastTs = candles?.length ? candles[candles.length - 1]?.t : 0;
  const delaySec = lastTs ? Math.floor(Date.now() / 1000 - lastTs) : 0;
  const delayText = delaySec > 120
    ? `${Math.floor(delaySec / 60)}m`
    : delaySec > 0 ? `~${delaySec}s` : '~1-2 min';

  if (!candles?.length && !lastScan) return null;

  return (
    <div style={{ fontSize: 10, color: '#8892a8', textAlign: 'right', marginTop: -8, marginBottom: 4, paddingRight: 2 }}>
      {sourceName}
      {showDelay && <> · delayed by {delayText}</>}
      {lastScan && <> · scanned {lastScan}</>}
    </div>
  );
}

// Categories are engine-dependent — initialized after engineVersion state

const NSE_SYM_CACHE_PREFIX = 'candlescan_nse_syms_v1_';
const NSE_SYM_CACHE_MS = 45 * 60 * 1000;

function readNseSymsCache(indexId) {
  try {
    const raw = sessionStorage.getItem(NSE_SYM_CACHE_PREFIX + indexId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const { t, syms, companyMap: cm } = parsed;
    if (!Array.isArray(syms) || Date.now() - t > NSE_SYM_CACHE_MS) return null;
    return { syms, companyMap: cm || {} };
  } catch {
    return null;
  }
}

function writeNseSymsCache(indexId, syms, companyMap) {
  try {
    sessionStorage.setItem(NSE_SYM_CACHE_PREFIX + indexId, JSON.stringify({ t: Date.now(), syms, companyMap }));
  } catch {
    /* quota */
  }
}

const shell = {
  minHeight: '100vh',
  background: '#f5f6f8',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  fontSize: 14,
  color: '#1a1d26',
  padding: '12px 12px 32px',
  maxWidth: 620,
  margin: '0 auto',
  boxSizing: 'border-box',
};

export default function App() {
  const [engineVersion, setEngineVersion] = useState(() => {
    try { return localStorage.getItem('candlescan_engine') || 'scalp'; } catch { return 'scalp'; }
  });
  const [scalpVariant, setScalpVariant] = useState(() => {
    try { return localStorage.getItem('candlescan_scalp_variant') || DEFAULT_SCALP_VARIANT; } catch { return DEFAULT_SCALP_VARIANT; }
  });

  useEffect(() => {
    try { localStorage.setItem('candlescan_engine', engineVersion); } catch { /* quota */ }
    // Reset signal filters when engine changes (different category sets)
    setActiveFilters(new Set(getCategoriesForEngine(engineVersion)));
    // Auto-set timeframe per engine
    if (engineVersion === 'scalp') setTimeframe('1m');
    else if (engineVersion === 'v2') setTimeframe('5m');
    // Classic: no auto-set (user picks, typically 1d)
  }, [engineVersion]);
  useEffect(() => {
    try { localStorage.setItem('candlescan_scalp_variant', scalpVariant); } catch { /* quota */ }
  }, [scalpVariant]);
  const [timeframe, setTimeframe] = useState(() => {
    try {
      const eng = localStorage.getItem('candlescan_engine') || 'scalp';
      return eng === 'scalp' ? '1m' : '5m';
    } catch { return '5m'; }
  });
  const [inputVal, setInputVal] = useState('');
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
  // Lazy-prefetch state: increases when the user scrolls near the left edge.
  // Reset on every fresh scan in runScan() so a new symbol starts at level 0.
  const [lookbackLevel, setLookbackLevel] = useState(0);
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);
  // Per-stock news for the detail screen — fetched async after a scan,
  // independent of the technical pipeline. Shape matches batchScan result:
  // { score, sentiment, headlines: [{title, description, score, source}] }.
  const [stockNews, setStockNews] = useState(null);
  const [stockNewsLoading, setStockNewsLoading] = useState(false);
  const stockNewsReqIdRef = useRef(0);
  const activeSymRef = useRef('');
  const chartRef = useRef(null);
  const [chartInfo, setChartInfo] = useState({ barCount: 0, atMinZoom: false, atMaxZoom: false });

  const [dataSource, setDataSourceState] = useState(() => {
    try { return localStorage.getItem('candlescan_data_source') || 'yahoo'; } catch { return 'yahoo'; }
  });
  const [zerodhaExpiredMsg, setZerodhaExpiredMsg] = useState('');
  const [lastUsedSource, setLastUsedSource] = useState('yahoo');
  const [sourceDebugReason, setSourceDebugReason] = useState('');

  const [nseIndex, setNseIndex] = useState(() => {
    try {
      const s = localStorage.getItem('candlescan_nse_index');
      if (s && getAllIndexOptions().some((o) => o.id === s)) return s;
    } catch {
      /* ignore */
    }
    return DEFAULT_NSE_INDEX_ID;
  });
  const [customIndices, setCustomIndices] = useState(() => getCustomIndices());
  // Use getBuiltInIndexOptions() so TOP GAINERS/LOSERS labels reflect live market state.
  // Recomputed on every render — cheap, keeps labels fresh as the market opens/closes.
  const allIndexOptions = [...getBuiltInIndexOptions(), ...customIndices];

  const handleAddCustomIndex = useCallback((id) => {
    const updated = addCustomIndex(id);
    setCustomIndices(updated);
  }, []);

  const handleRemoveCustomIndex = useCallback((id) => {
    const updated = removeCustomIndex(id);
    setCustomIndices(updated);
    if (nseIndex === id) setNseIndex(DEFAULT_NSE_INDEX_ID);
  }, [nseIndex]);

  const [constituents, setConstituents] = useState([]);
  const [constituentsLoading, setConstituentsLoading] = useState(false);
  const [constituentsError, setConstituentsError] = useState('');
  const [companyMap, setCompanyMap] = useState({}); // SYMBOL → "Company Name"
  const [broadSearchSymbols, setBroadSearchSymbols] = useState([]); // NIFTY 500 symbols for global search
  const [broadCompanyMap, setBroadCompanyMap] = useState({}); // NIFTY 500 company map
  const [refreshKey, setRefreshKey] = useState(0); // Bump to force re-fetch constituents
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Signal filter state
  const [activeFilters, setActiveFilters] = useState(() => new Set(getCategoriesForEngine(engineVersion)));

  // Signal highlight toggle
  const [highlightSignals, setHighlightSignals] = useState(true);

  // View state: 'main' | 'batch' | 'simulate' | 'paper' | 'novice' | 'settings'
  // Auto-navigate to settings if returning from Zerodha OAuth callback
  const [view, setViewRaw] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('request_token') && params.get('action') === 'login') return 'settings';
    return 'main';
  });
  const [cameFromBatch, setCameFromBatch] = useState(false);
  const [cameFromSimulation, setCameFromSimulation] = useState(false);
  // Remember the view the user was on before entering Settings so "Back"
  // returns there instead of always jumping to the stock scanner.
  const [settingsReturnView, setSettingsReturnView] = useState('main');

  // Re-sync dataSource from localStorage when returning from Settings or on page reload
  useEffect(() => {
    if (view === 'main') {
      try {
        const stored = localStorage.getItem('candlescan_data_source') || 'yahoo';
        setDataSourceState(stored);
        // Auto-correct timeframe if not available for the new source
        const available = SOURCE_TIMEFRAMES[stored] || SOURCE_TIMEFRAMES.yahoo;
        if (!available.includes(timeframe)) {
          // Pick nearest: if 30m not in dhan, use 15m; if 25m not in yahoo, use 30m
          const fallback = available.includes('5m') ? '5m' : available[0];
          setTimeframe(fallback);
        }
      } catch { /* ok */ }
    }
  }, [view]);

  const lastBackTime = useRef(0);
  const viewRef = useRef('main'); // track current view for popstate handler

  // Simple navigation: back always goes to home, double-back exits app.
  // No history stack — replaceState, not pushState.
  const setView = useCallback((newView) => {
    viewRef.current = newView;
    setViewRaw(newView);
    // Push one entry when leaving home so back button can return to home
    if (newView !== 'main') {
      window.history.pushState({ view: 'non-main' }, '', '');
    }
  }, []);

  useEffect(() => {
    window.history.replaceState({ view: 'main' }, '', '');

    const onPopState = () => {
      if (viewRef.current !== 'main') {
        // On any non-home page → go straight to home (not previous page)
        viewRef.current = 'main';
        setViewRaw('main');
        setCameFromBatch(false);
        setCameFromSimulation(false);
        // Ensure we stay at single history entry
        window.history.replaceState({ view: 'main' }, '', '');
      } else {
        // Already on home — double-back within 2s to exit
        const now = Date.now();
        if (now - lastBackTime.current < 2000) {
          // Let browser close the PWA
          window.history.back();
          return;
        }
        lastBackTime.current = now;
        // Re-push so next back press can be caught
        window.history.pushState({ view: 'home-guard' }, '', '');
      }
    };

    // Push one entry as guard for the home double-back
    window.history.pushState({ view: 'home-guard' }, '', '');

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const [debugMode, setDebugMode] = useState(false);

  // Drawing tool state
  const [drawingMode, setDrawingMode] = useState(null);
  const [drawingsMap, setDrawingsMap] = useState({});

  // History with localStorage persistence
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


  useEffect(() => {
    try {
      localStorage.setItem('candlescan_nse_index', nseIndex);
    } catch {
      /* quota */
    }
  }, [nseIndex]);

  // Pre-fetch NIFTY TOTAL MARKET (~750 stocks) for broad search universe
  const SEARCH_UNIVERSE_KEY = '__SEARCH_UNIVERSE__';
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = readNseSymsCache(SEARCH_UNIVERSE_KEY);
      if (cached?.syms?.length) {
        setBroadSearchSymbols(cached.syms);
        setBroadCompanyMap(cached.companyMap || {});
        return;
      }
      try {
        const result = await fetchNseIndexWithNames('NIFTY TOTAL MARKET');
        if (!cancelled && result.symbols.length) {
          setBroadSearchSymbols(result.symbols);
          setBroadCompanyMap(result.companyMap || {});
          writeNseSymsCache(SEARCH_UNIVERSE_KEY, result.symbols, result.companyMap);
        }
      } catch { /* silent — fallback to current index */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Skip sessionStorage cache for dynamic indices (auto-refreshing)
      if (!isDynamicIndex(nseIndex)) {
        const cached = readNseSymsCache(nseIndex);
        if (cached?.syms?.length) {
          setConstituents(cached.syms);
          setCompanyMap(cached.companyMap || {});
          setConstituentsError('');
          setConstituentsLoading(false);
          return;
        }
      }
      // Don't show loading/clear for auto-refresh of dynamic indices
      const isAutoRefresh = isDynamicIndex(nseIndex) && constituents.length > 0;
      if (!isAutoRefresh) {
        setConstituentsLoading(true);
        setConstituentsError('');
        setConstituents([]);
      }
      try {
        const result = await fetchNseIndexWithNames(nseIndex);
        if (!cancelled) {
          setConstituents(result.symbols);
          setCompanyMap(result.companyMap || {});
          writeNseSymsCache(nseIndex, result.symbols, result.companyMap);
        }
      } catch (e) {
        if (!cancelled) {
          setConstituentsError(e?.message || 'Could not load NSE index.');
          setConstituents([]);
        }
      } finally {
        if (!cancelled) setConstituentsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nseIndex, refreshKey]);

  // Auto-refresh dynamic indices (Top Gainers/Losers) every 30 seconds
  useEffect(() => {
    if (!isDynamicIndex(nseIndex)) return;
    const interval = setInterval(() => setRefreshKey(k => k + 1), 30000);
    return () => clearInterval(interval);
  }, [nseIndex]);

  const runScan = useCallback(async (symbol) => {
    const s = String(symbol).trim();
    if (!s) return;
    setLoading(true);
    setScanError('');
    setQuote(null);
    setZerodhaExpiredMsg('');
    // Fresh scan → reset lazy prefetch state so the next left-edge
    // scroll starts from level 0 again.
    setLookbackLevel(0);
    // Fresh scan → clear any stale news from the previous symbol and
    // reset the in-flight ID so late responses from an old scan can't
    // land on the new view.
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
              // Token actually expired/invalid — clear vault and switch source
              const isTokenExpiry = /TokenException|Incorrect.*api_key|token.*invalid|token.*expired/i.test(err);
              // Permission error (e.g. no Historical Data add-on) — DON'T clear vault
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

      // Grow search universe with newly discovered symbols
      if (displaySymbol && cn && !broadCompanyMap[displaySymbol]) {
        setBroadSearchSymbols(prev => prev.includes(displaySymbol) ? prev : [...prev, displaySymbol]);
        setBroadCompanyMap(prev => ({ ...prev, [displaySymbol]: cn }));
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
        const varFns = getScalpVariantFns(scalpVariant);
        detectPat = varFns.detectPatterns;
        detectBox = varFns.detectLiquidityBox;
        scoreRisk = varFns.computeRiskScore;
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

      // Fire-and-forget async news fetch for this symbol — doesn't block
      // the scan. When it lands we check newsReqId vs the latest to guard
      // against late responses overwriting a newer scan's news.
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
  }, [timeframe, engineVersion, scalpVariant, nseIndex, dataSource]);

  useEffect(() => {
    if (simulated || !yahooSym || !risk) {
      setQuote(null);
      return undefined;
    }
    let cancelled = false;
    fetchYahooQuote(yahooSym).then((q) => {
      if (!cancelled) setQuote(q);
    });
    return () => {
      cancelled = true;
    };
  }, [simulated, yahooSym, risk, lastScan]);

  useEffect(() => {
    if (!activeSymRef.current) return;
    runScan(activeSymRef.current);
  }, [timeframe, runScan]);

  /**
   * Lazy-prefetch more history for the current chart when the user
   * scrolls near the left edge. Yahoo-only for now: premium sources
   * (Zerodha / Dhan) use date-range APIs that don't compose cleanly
   * with a "lookback level" abstraction, and their users rarely hit
   * the multi-day history limit anyway.
   *
   * Merge strategy: fetch a wider range, dedupe the combined set by
   * timestamp (newer fetch wins), sort ascending. Chart.jsx detects
   * the prepend (same last-candle ts, grown length) and preserves
   * the user's scroll position automatically.
   */
  const handleLoadMoreHistory = useCallback(async () => {
    // Only Yahoo supports the `lookbackLevel` option — silently no-op
    // for premium sources so the user's scroll gesture doesn't hang.
    if (lastUsedSource !== 'yahoo') return;
    if (loadingMoreHistory) return;
    if (!activeSymRef.current) return;
    const nextLevel = lookbackLevel + 1;
    // Max level is determined by EXTENDED_LOOKBACKS in fetcher.js.
    // We let fetcher clamp internally; if the returned candle count
    // doesn't grow, we treat it as "no more data" and stop.
    setLoadingMoreHistory(true);
    try {
      const res = await fetchOHLCV(activeSymRef.current, timeframe, { lookbackLevel: nextLevel });
      if (!res?.candles?.length) return;
      // Merge: dedupe by `t`, keep the newer candle on collisions
      // (later fetches may revise the most recent bar).
      const byTs = new Map();
      for (const c of candles) byTs.set(c.t, c);
      for (const c of res.candles) byTs.set(c.t, c);
      const merged = Array.from(byTs.values()).sort((a, b) => a.t - b.t);
      // Only commit if we actually got more history — otherwise we've
      // hit Yahoo's range ceiling and should stop trying.
      if (merged.length > candles.length) {
        setCandles(merged);
        setLookbackLevel(nextLevel);
      }
    } catch {
      // Silent: lazy-prefetch failure shouldn't interrupt the scan session
    } finally {
      setLoadingMoreHistory(false);
    }
  }, [lastUsedSource, loadingMoreHistory, lookbackLevel, timeframe, candles]);

  // Merge broad NIFTY 500 universe + current index for homepage search
  const searchSymbols = useMemo(() => {
    const set = new Set(broadSearchSymbols);
    for (const s of constituents) set.add(s);
    return Array.from(set).sort();
  }, [broadSearchSymbols, constituents]);

  const searchCompanyMap = useMemo(() => {
    return { ...broadCompanyMap, ...companyMap };
  }, [broadCompanyMap, companyMap]);

  const onQuick = (t) => {
    setInputVal(t);
    runScan(t);
  };

  const onScanClick = (sym) => { setCameFromBatch(false); setCameFromSimulation(false); runScan(sym || inputVal); };

  const changePct =
    candles.length >= 2
      ? ((candles[candles.length - 1].c - candles[candles.length - 2].c) /
          Math.max(candles[candles.length - 2].c, 1e-9)) *
        100
      : 0;

  const chartH = 260;

  // Filter patterns for display (score uses all patterns)
  const filteredPatterns = patterns.filter((p) => activeFilters.has(p.category));

  const currentCategories = getCategoriesForEngine(engineVersion);
  const signalMeta = {
    categoryCount: currentCategories.length,
    rulesApprox: getRuleCountForEngine(engineVersion),
  };

  const viewProps = {
    sym,
    companyName,
    candles,
    patterns: filteredPatterns,
    allPatterns: patterns,
    risk,
    box,
    changePct,
    activeFilters,
    viewMode: 'advanced',
    yahooSymbol: yahooSym,
    quote,
    signalMeta,
    stockNews,
    stockNewsLoading,
  };

  // Drawings for current symbol
  const currentDrawings = drawingsMap[sym] || [];
  const handleDrawingComplete = (drawing) => {
    setDrawingsMap((prev) => ({
      ...prev,
      [sym]: [...(prev[sym] || []), drawing],
    }));
    setDrawingMode(null); // one-shot: deactivate after placing
  };
  const handleDrawingUpdate = (idx, updated) => {
    setDrawingsMap((prev) => {
      const arr = [...(prev[sym] || [])];
      arr[idx] = updated;
      return { ...prev, [sym]: arr };
    });
  };
  const clearDrawings = () => {
    setDrawingsMap((prev) => {
      const next = { ...prev };
      delete next[sym];
      return next;
    });
    setDrawingMode(null);
  };

  return (
    <div style={shell}>
      <UpdatePrompt />
      {/* Shared header — single instance, nav action changes per view */}
      <Header>
        <GlobalMenu
          activeFilters={activeFilters}
          onFiltersChange={setActiveFilters}
          navAction={view === 'main'
            ? { label: 'Index Scanner', onClick: () => setView('batch') }
            : { label: 'Stock Scanner', onClick: () => setView('main') }
          }
          noviceAction={{
            label: view === 'novice' ? 'Back to Stock Scanner' : 'Novice Mode',
            onClick: () => setView(view === 'novice' ? 'main' : 'novice'),
          }}
          simulationAction={{
            label: view === 'simulate' ? 'Index Scanner' : 'Simulation',
            onClick: () => setView(view === 'simulate' ? 'batch' : 'simulate'),
          }}
          paperTradingAction={{
            label: view === 'paper' ? 'Index Scanner' : 'Paper Trading',
            onClick: () => setView(view === 'paper' ? 'batch' : 'paper'),
          }}
          settingsAction={{
            label: 'Settings',
            onClick: () => {
              // Remember where we are so Back from Settings returns here
              if (view !== 'settings') setSettingsReturnView(view);
              setView('settings');
            },
          }}
          customIndices={customIndices}
          onAddCustomIndex={handleAddCustomIndex}
          onRemoveCustomIndex={handleRemoveCustomIndex}
          engineVersion={engineVersion}
          onEngineVersionChange={setEngineVersion}
          scalpVariant={scalpVariant}
          onScalpVariantChange={setScalpVariant}
        />
      </Header>

      {/* Batch scan page — always mounted, hidden when not active */}
      <div style={{ display: view === 'batch' ? 'block' : 'none' }}>
        <BatchScanPage
          onSelectSymbol={(s) => {
            setInputVal(s);
            onQuick(s);
            setView('main');
            setCameFromBatch(true);
          }}
          savedIndex={nseIndex}
          indexOptions={allIndexOptions}
          engineVersion={engineVersion}
          scalpVariant={scalpVariant}
          dataSource={dataSource}
          debugMode={debugMode}
        />
      </div>

      {/* Simulation page — always mounted, hidden when not active */}
      <div style={{ display: view === 'simulate' ? 'block' : 'none' }}>
        <SimulationPage
          onSelectSymbol={(s) => {
            setInputVal(s);
            onQuick(s);
            setView('main');
            setCameFromSimulation(true);
          }}
          savedIndex={nseIndex}
          indexOptions={allIndexOptions}
          engineVersion={engineVersion}
          scalpVariant={scalpVariant}
          onScalpVariantChange={setScalpVariant}
          dataSource={dataSource}
          debugMode={debugMode}
        />
      </div>

      {/* Paper trading page — always mounted, hidden when not active */}
      <div style={{ display: view === 'paper' ? 'block' : 'none' }}>
        <PaperTradingPage
          savedIndex={nseIndex}
          indexOptions={allIndexOptions}
          engineVersion={engineVersion}
          scalpVariant={scalpVariant}
          dataSource={dataSource}
        />
      </div>

      {/* Novice mode page — always mounted, hidden when not active.
          One-button UX for non-technical users. Leaf view: taps flow
          back into the main stock scanner via onSelectSymbol. */}
      <div style={{ display: view === 'novice' ? 'block' : 'none' }}>
        <NoviceModePage
          savedIndex={nseIndex}
          indexOptions={allIndexOptions}
          dataSource={dataSource}
          onSelectSymbol={(s) => {
            setInputVal(s);
            onQuick(s);
            setView('main');
          }}
        />
      </div>

      {/* Settings page */}
      {view === 'settings' && (
        <SettingsPage onBack={() => setView(settingsReturnView)} debugMode={debugMode} onDebugModeChange={setDebugMode} />
      )}

      {/* Main view — hidden when not active */}
      <div style={{ display: view === 'main' ? 'block' : 'none' }}>
      {cameFromBatch && (
        <button
          type="button"
          onClick={() => { setView('batch'); setCameFromBatch(false); }}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, width: '100%',
            padding: '8px 12px', marginBottom: 10, borderRadius: 8,
            border: '1px solid #e2e5eb', background: '#eff6ff',
            color: '#2563eb', fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}
        >
          ← Back to scan results
        </button>
      )}
      {cameFromSimulation && (
        <button
          type="button"
          onClick={() => { setView('simulate'); setCameFromSimulation(false); }}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, width: '100%',
            padding: '8px 12px', marginBottom: 10, borderRadius: 8,
            border: '1px solid #e2e5eb', background: '#eff6ff',
            color: '#2563eb', fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}
        >
          ← Back to simulation results
        </button>
      )}
      <SearchBar
        inputVal={inputVal}
        setInputVal={setInputVal}
        onScan={onScanClick}
        loading={loading}
        onOpenStockList={() => setSidebarOpen(true)}
        universeLabel={
          allIndexOptions.find((o) => o.id === nseIndex)?.label ?? nseIndex
        }
        symbols={searchSymbols}
        companyMap={searchCompanyMap}
      />

      {loading && (
        <div style={{ height: 4, borderRadius: 2, background: '#e2e5eb', marginBottom: 12, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: '40%', background: '#2563eb', animation: 'csload 0.9s ease-in-out infinite' }} />
        </div>
      )}

      {history.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: '#8892a8', marginBottom: 4 }}>Recent</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {history.map((h) => (
              <button
                key={h.symbol}
                type="button"
                onClick={() => onQuick(h.symbol)}
                style={{
                  minHeight: 28,
                  padding: '0 8px',
                  fontSize: 11,
                  fontWeight: 600,
                  borderRadius: 6,
                  border: '1px solid #e2e5eb',
                  background: '#fff',
                  color: h.riskScore >= 70 ? '#16a34a' : h.riskScore >= 55 ? '#d97706' : '#8892a8',
                  cursor: 'pointer',
                }}
              >
                {h.symbol} ({h.riskScore})
              </button>
            ))}
          </div>
        </div>
      )}

      {zerodhaExpiredMsg && (
        <div
          style={{
            padding: 12,
            borderRadius: 10,
            background: '#fefce8',
            border: '1px solid #fde68a',
            color: '#92400e',
            fontSize: 13,
            lineHeight: 1.5,
            marginBottom: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <span>{zerodhaExpiredMsg}</span>
          <button
            type="button"
            onClick={() => setZerodhaExpiredMsg('')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#92400e', fontSize: 16, lineHeight: 1, padding: 2, flexShrink: 0 }}
            aria-label="Dismiss"
          >×</button>
        </div>
      )}

      {scanError ? (
        <div
          role="alert"
          style={{
            padding: 14,
            borderRadius: 10,
            background: '#fef2f2',
            border: '1px solid #fecaca',
            color: '#991b1b',
            fontSize: 14,
            lineHeight: 1.5,
            marginBottom: 12,
          }}
        >
          {scanError}
        </div>
      ) : null}

      {!sym ? (
        <EmptyState />
      ) : scanError ? null : !risk ? (
        <EmptyState />
      ) : (
        <>
          {/* Row 1: Timeframe pills */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
            <TimeframePills value={timeframe} onChange={setTimeframe} available={SOURCE_TIMEFRAMES[dataSource]} />
          </div>
          {/* Row 2: bar count, drawing, signals, zoom — single dense row */}
          <div style={{ display: 'flex', gap: 5, marginBottom: 6, alignItems: 'center', flexWrap: 'nowrap' }}>
            <span style={{ fontSize: 10, color: '#b0b8c8', whiteSpace: 'nowrap' }}>
              {chartRef.current?.barCount || candles?.length || 0} bars
            </span>
            <DrawingToolbar active={drawingMode} onChange={setDrawingMode} onClear={clearDrawings} />
            <ToggleSwitch checked={highlightSignals} onChange={setHighlightSignals} label="Signals" compact />
            <div style={{ flex: 1 }} />
            <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => chartRef.current?.zoomIn()}
              disabled={chartRef.current?.atMinZoom}
              style={{ minWidth: 34, minHeight: 32, padding: '0 8px', borderRadius: 8, border: '1px solid #e2e5eb', background: '#fff', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', opacity: chartRef.current?.atMinZoom ? 0.35 : 1 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
              </svg>
            </button>
            <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => chartRef.current?.zoomOut()}
              disabled={chartRef.current?.atMaxZoom}
              style={{ minWidth: 34, minHeight: 32, padding: '0 8px', borderRadius: 8, border: '1px solid #e2e5eb', background: '#fff', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', opacity: chartRef.current?.atMaxZoom ? 0.35 : 1 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>
              </svg>
            </button>
            <button type="button" aria-label="Reset zoom" title="Reset to today" onClick={() => chartRef.current?.zoomFit()}
              style={{ minWidth: 34, minHeight: 32, padding: '0 8px', borderRadius: 8, border: '1px solid #e2e5eb', background: '#fff', color: '#2563eb', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
              </svg>
            </button>
          </div>
          <Chart
            ref={chartRef}
            candles={candles}
            box={box}
            risk={risk}
            height={chartH}
            sym={sym}
            timeframe={timeframe}
            drawingMode={drawingMode}
            drawings={currentDrawings}
            onDrawingComplete={handleDrawingComplete}
            onDrawingUpdate={handleDrawingUpdate}
            patterns={patterns}
            highlightSignals={highlightSignals}
            onNearLeftEdge={handleLoadMoreHistory}
            loadingMore={loadingMoreHistory}
          />
          <DataDelayDisclaimer candles={candles} simulated={simulated} dataSource={lastUsedSource} lastScan={lastScan} />
          {debugMode && sourceDebugReason && (
            <div style={{
              fontSize: 10, color: '#64748b', background: '#f8fafc', border: '1px solid #e2e5eb',
              borderRadius: 6, padding: '6px 10px', marginBottom: 8, fontFamily: "'SF Mono', Menlo, monospace",
              lineHeight: 1.5, wordBreak: 'break-all',
            }}>
              <strong>Source:</strong> {lastUsedSource} | {sourceDebugReason}
            </div>
          )}
          <AdvancedView {...viewProps} />
        </>
      )}

      <IndexConstituentsSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        indexLabel={nseIndex}
        nseIndexOptions={allIndexOptions}
        selectedNseIndex={nseIndex}
        onNseIndexChange={setNseIndex}
        symbols={constituents}
        companyMap={companyMap}
        loading={constituentsLoading}
        error={constituentsError}
        onSelectSymbol={(s) => {
          setInputVal(s);
          onQuick(s);
        }}
        isDynamic={isDynamicIndex(nseIndex)}
        onRefresh={() => setRefreshKey(k => k + 1)}
      />

      <footer
        style={{
          marginTop: 24,
          paddingTop: 16,
          borderTop: '1px solid #e2e5eb',
          fontSize: 11,
          color: '#8892a8',
          lineHeight: 1.5,
        }}
      >
        {simulated ? (
          <p style={{ margin: '0 0 8px' }}>
            Demo data — you are in dev mode with <code style={{ fontSize: 11 }}>?simulate=1</code>.
            Remove it to load real Yahoo Finance data.
          </p>
        ) : null}
        <p style={{ margin: 0 }}>
          Educational tool only — not financial advice. You are responsible for your trades.
        </p>
      </footer>
      </div>{/* end main view */}

      <style>{`
        @keyframes csload {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(350%); }
        }
        * { box-sizing: border-box; }
        body { margin: 0; overflow-x: hidden; }
        html { overflow-x: hidden; }
      `}</style>

      <DebugPanel open={debugMode} onClose={() => setDebugMode(false)} />
    </div>
  );
}
