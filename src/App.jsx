import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { fetchOHLCV } from './engine/fetcher.js';
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
import TimeframePills from './components/TimeframePills.jsx';
import SearchBar from './components/SearchBar.jsx';
import Chart from './components/Chart.jsx';
import EmptyState from './components/EmptyState.jsx';
import SimpleView from './components/SimpleView.jsx';
import AdvancedView from './components/AdvancedView.jsx';
import GlobalMenu from './components/GlobalMenu.jsx';
import DrawingToolbar from './components/DrawingToolbar.jsx';
import IndexConstituentsSidebar from './components/IndexConstituentsSidebar.jsx';
import BatchScanPage from './components/BatchScanPage.jsx';
import SimulationPage from './components/SimulationPage.jsx';
import PaperTradingPage from './components/PaperTradingPage.jsx';
import SettingsPage from './components/SettingsPage.jsx';
import DebugPanel from './components/DebugPanel.jsx';
import UpdatePrompt from './components/UpdatePrompt.jsx';
import { getMarketStatus } from './utils/marketHours.js';
import { NSE_INDEX_OPTIONS, DEFAULT_NSE_INDEX_ID, getCustomIndices, addCustomIndex, removeCustomIndex, getAllIndexOptions } from './config/nseIndices.js';
import { hasGateToken, getGateToken } from './utils/batchAuth.js';
import { getVaultBlob, hasVault, clearVault } from './utils/credentialVault.js';
import { fetchZerodhaOHLCV } from './engine/zerodhaFetcher.js';
import { SIGNAL_CATEGORIES, APPROX_PATTERN_RULES, getCategoriesForEngine, getRuleCountForEngine } from './data/signalCategories.js';
import { fetchNseIndexSymbolList, fetchNseIndexWithNames } from './engine/nseIndexFetch.js';
import { fetchYahooQuote } from './engine/yahooQuote.js';

function DataDelayDisclaimer({ candles, simulated, dataSource }) {
  const status = getMarketStatus();
  if (simulated || !candles?.length || !status.isOpen) return null;

  const sourceName = dataSource === 'zerodha' ? 'Zerodha Kite' : 'Yahoo Finance';
  // Only show during market hours when data may be delayed
  const lastTs = candles[candles.length - 1]?.t;
  const delaySec = lastTs ? Math.floor(Date.now() / 1000 - lastTs) : 0;
  const delayText = delaySec > 120
    ? `${Math.floor(delaySec / 60)}m`
    : delaySec > 0 ? `~${delaySec}s` : '~1-2 min';
  return (
    <div style={{ fontSize: 10, color: '#8892a8', textAlign: 'right', marginTop: -8, marginBottom: 4, paddingRight: 2 }}>
      Data delayed by {delayText} ({sourceName})
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
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem('candlescan_mode') || 'advanced'; } catch { return 'advanced'; }
  });
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
  const [live, setLive] = useState(false);
  const [simulated, setSimulated] = useState(false);
  const [scanError, setScanError] = useState('');
  const [candles, setCandles] = useState([]);
  const [patterns, setPatterns] = useState([]);
  const [box, setBox] = useState(null);
  const [risk, setRisk] = useState(null);
  const [lastScan, setLastScan] = useState('');
  const [yahooSym, setYahooSym] = useState('');
  const [quote, setQuote] = useState(null);
  const activeSymRef = useRef('');

  const [dataSource, setDataSourceState] = useState(() => {
    try { return localStorage.getItem('candlescan_data_source') || 'yahoo'; } catch { return 'yahoo'; }
  });
  const [zerodhaExpiredMsg, setZerodhaExpiredMsg] = useState('');
  const [lastUsedSource, setLastUsedSource] = useState('yahoo');

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
  const allIndexOptions = [...NSE_INDEX_OPTIONS, ...customIndices];

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
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Signal filter state
  const [activeFilters, setActiveFilters] = useState(() => new Set(getCategoriesForEngine(engineVersion)));

  // Signal highlight toggle
  const [highlightSignals, setHighlightSignals] = useState(true);

  // View state: 'main' | 'batch' | 'simulate' | 'settings'
  // Auto-navigate to settings if returning from Zerodha OAuth callback
  const [view, setViewRaw] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('request_token') && params.get('action') === 'login') return 'settings';
    return 'main';
  });
  const [cameFromBatch, setCameFromBatch] = useState(false);
  const [cameFromSimulation, setCameFromSimulation] = useState(false);

  // Ref to track whether popstate handler should skip (to avoid loops)
  const handlingPopState = useRef(false);
  const lastBackTime = useRef(0);

  // Wrap setView to push browser history state for back gesture/button support
  const setView = useCallback((newView) => {
    if (!handlingPopState.current) {
      window.history.pushState({ view: newView }, '', '');
    }
    setViewRaw(newView);
  }, []);

  // Handle back gesture/button via popstate — navigate within app instead of closing
  useEffect(() => {
    window.history.replaceState({ view: 'main' }, '', '');

    const onPopState = (e) => {
      handlingPopState.current = true;
      const targetView = e.state?.view;

      if (targetView && targetView !== 'main') {
        setViewRaw(targetView);
      } else {
        // At root — double-back within 2s to close, otherwise stay
        const now = Date.now();
        if (now - lastBackTime.current < 2000) {
          // Let browser handle it (close PWA / navigate away)
          handlingPopState.current = false;
          return;
        }
        lastBackTime.current = now;
        window.history.pushState({ view: 'main' }, '', '');
        setViewRaw('main');
        setCameFromBatch(false);
        setCameFromSimulation(false);
      }
      handlingPopState.current = false;
    };

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
    try { localStorage.setItem('candlescan_mode', mode); } catch { /* quota */ }
  }, [mode]);

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
      const cached = readNseSymsCache(nseIndex);
      if (cached?.syms?.length) {
        setConstituents(cached.syms);
        setCompanyMap(cached.companyMap || {});
        setConstituentsError('');
        setConstituentsLoading(false);
        return;
      }
      setConstituentsLoading(true);
      setConstituentsError('');
      setConstituents([]);
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
  }, [nseIndex]);

  const runScan = useCallback(async (symbol) => {
    const s = String(symbol).trim();
    if (!s) return;
    setLoading(true);
    setScanError('');
    setQuote(null);
    setZerodhaExpiredMsg('');
    try {
      let result;
      let usedSource = dataSource;

      // Try Zerodha first if configured
      if (dataSource === 'zerodha' && hasVault()) {
        const vault = getVaultBlob();
        const gateToken = getGateToken();
        if (vault && gateToken) {
          result = await fetchZerodhaOHLCV(s, timeframe, { vault, gateToken });
          // If Zerodha fails with auth error, fallback to Yahoo
          if (result.error && /403|401|token|expired|InputException/i.test(result.error)) {
            clearVault();
            try { localStorage.setItem('candlescan_data_source', 'yahoo'); } catch { /* ok */ }
            setDataSourceState('yahoo');
            setZerodhaExpiredMsg('Zerodha token expired — switched to Yahoo Finance. Reconnect in Settings.');
            result = null;
            usedSource = 'yahoo';
          } else if (result.error) {
            // Other Zerodha error — fallback to Yahoo silently
            result = null;
            usedSource = 'yahoo';
          }
        } else {
          usedSource = 'yahoo';
        }
      }

      // Fallback to Yahoo Finance
      if (!result || (!result.candles?.length && !result.error)) {
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
      setLive(!!lv);

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
    if (mode !== 'advanced' || simulated || !yahooSym || !risk) {
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
  }, [mode, simulated, yahooSym, risk, lastScan]);

  useEffect(() => {
    if (!activeSymRef.current) return;
    runScan(activeSymRef.current);
  }, [timeframe, runScan]);

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

  let headerBadge = 'idle';
  if (loading) headerBadge = 'idle';
  else if (scanError) headerBadge = 'offline';
  else if (simulated) headerBadge = 'demo';
  else if (sym && candles.length) headerBadge = live ? 'live' : 'offline';

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
    viewMode: mode,
    yahooSymbol: yahooSym,
    quote,
    signalMeta,
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
      <Header badge={headerBadge} lastScan={lastScan}>
        <GlobalMenu
          activeFilters={activeFilters}
          onFiltersChange={setActiveFilters}
          navAction={view === 'main'
            ? { label: 'Index Scanner', onClick: () => setView('batch') }
            : { label: 'Stock Scanner', onClick: () => setView('main') }
          }
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
            onClick: () => setView('settings'),
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
        />
      </div>

      {/* Paper trading page — always mounted, hidden when not active */}
      <div style={{ display: view === 'paper' ? 'block' : 'none' }}>
        <PaperTradingPage
          savedIndex={nseIndex}
          indexOptions={allIndexOptions}
          engineVersion={engineVersion}
          scalpVariant={scalpVariant}
        />
      </div>

      {/* Settings page */}
      {view === 'settings' && (
        <SettingsPage onBack={() => setView('main')} debugMode={debugMode} onDebugModeChange={setDebugMode} mode={mode} onModeChange={setMode} />
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
          {/* Timeframe + drawing tools + highlight signals — single row */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <TimeframePills value={timeframe} onChange={setTimeframe} />
            <div style={{ flex: 1, minWidth: 4 }} />
            <DrawingToolbar active={drawingMode} onChange={setDrawingMode} onClear={clearDrawings} />
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 3,
                fontSize: 11,
                fontWeight: 600,
                color: highlightSignals ? '#2563eb' : '#8892a8',
                cursor: 'pointer',
                userSelect: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              <input
                type="checkbox"
                checked={highlightSignals}
                onChange={(e) => setHighlightSignals(e.target.checked)}
                style={{ accentColor: '#2563eb', margin: 0, width: 13, height: 13 }}
              />
              Signals
            </label>
          </div>
          <Chart
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
          />
          <DataDelayDisclaimer candles={candles} simulated={simulated} dataSource={lastUsedSource} />
          {mode === 'advanced' ? <AdvancedView {...viewProps} /> : <SimpleView {...viewProps} />}
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
