import { useState, useCallback, useEffect, useRef } from 'react';
import { fetchOHLCV } from './engine/fetcher.js';
import { detectPatterns } from './engine/patterns.js';
import { detectLiquidityBox } from './engine/liquidityBox.js';
import { computeRiskScore } from './engine/risk.js';
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
import { NSE_INDEX_OPTIONS, DEFAULT_NSE_INDEX_ID } from './config/nseIndices.js';
import { SIGNAL_CATEGORIES, APPROX_PATTERN_RULES } from './data/signalCategories.js';
import { fetchNseIndexSymbolList } from './engine/nseIndexFetch.js';
import { fetchYahooQuote } from './engine/yahooQuote.js';

const ALL_CATEGORIES = new Set(SIGNAL_CATEGORIES);

const NSE_SYM_CACHE_PREFIX = 'candlescan_nse_syms_v1_';
const NSE_SYM_CACHE_MS = 45 * 60 * 1000;

function readNseSymsCache(indexId) {
  try {
    const raw = sessionStorage.getItem(NSE_SYM_CACHE_PREFIX + indexId);
    if (!raw) return null;
    const { t, syms } = JSON.parse(raw);
    if (!Array.isArray(syms) || Date.now() - t > NSE_SYM_CACHE_MS) return null;
    return syms;
  } catch {
    return null;
  }
}

function writeNseSymsCache(indexId, syms) {
  try {
    sessionStorage.setItem(NSE_SYM_CACHE_PREFIX + indexId, JSON.stringify({ t: Date.now(), syms }));
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
    try { return localStorage.getItem('candlescan_mode') || 'simple'; } catch { return 'simple'; }
  });
  const [timeframe, setTimeframe] = useState('5m');
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

  const [nseIndex, setNseIndex] = useState(() => {
    try {
      const s = localStorage.getItem('candlescan_nse_index');
      if (s && NSE_INDEX_OPTIONS.some((o) => o.id === s)) return s;
    } catch {
      /* ignore */
    }
    return DEFAULT_NSE_INDEX_ID;
  });
  const [constituents, setConstituents] = useState([]);
  const [constituentsLoading, setConstituentsLoading] = useState(false);
  const [constituentsError, setConstituentsError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Signal filter state
  const [activeFilters, setActiveFilters] = useState(ALL_CATEGORIES);

  // Signal highlight toggle
  const [highlightSignals, setHighlightSignals] = useState(true);

  // View state: 'main' | 'batch'
  const [view, setView] = useState('main');
  // Track if user navigated to main from batch (for back-to-batch button)
  const [cameFromBatch, setCameFromBatch] = useState(false);

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = readNseSymsCache(nseIndex);
      if (cached?.length) {
        setConstituents(cached);
        setConstituentsError('');
        setConstituentsLoading(false);
        return;
      }
      setConstituentsLoading(true);
      setConstituentsError('');
      setConstituents([]);
      try {
        const syms = await fetchNseIndexSymbolList(nseIndex);
        if (!cancelled) {
          setConstituents(syms);
          writeNseSymsCache(nseIndex, syms);
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
    try {
      const result = await fetchOHLCV(s, timeframe);
      const { candles: cd, live: lv, simulated: sim, error: err, companyName: cn, displaySymbol, yahooSymbol } = result;

      activeSymRef.current = displaySymbol;
      setSym(displaySymbol);
      setCompanyName(cn || displaySymbol);
      setYahooSym(yahooSymbol || '');
      setSimulated(!!sim);
      setLive(!!lv);

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
      const pat = detectPatterns(cd);
      const bx = detectLiquidityBox(cd);
      const rk = computeRiskScore({ candles: cd, patterns: pat, box: bx });
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
  }, [timeframe]);

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

  const onQuick = (t) => {
    setInputVal(t);
    runScan(t);
  };

  const onScanClick = () => { setCameFromBatch(false); runScan(inputVal); };

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

  const signalMeta = {
    categoryCount: SIGNAL_CATEGORIES.length,
    rulesApprox: APPROX_PATTERN_RULES,
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
      {/* Shared header — single instance, nav action changes per view */}
      <Header badge={headerBadge} lastScan={lastScan} mode={mode} onModeChange={setMode}>
        <GlobalMenu
          activeFilters={activeFilters}
          onFiltersChange={setActiveFilters}
          navAction={view === 'main'
            ? { label: 'Index Scanner', onClick: () => setView('batch') }
            : { label: 'Stock Scanner', onClick: () => setView('main') }
          }
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
        />
      </div>

      {/* Main view — hidden when batch is active */}
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
      <SearchBar
        inputVal={inputVal}
        setInputVal={setInputVal}
        onScan={onScanClick}
        loading={loading}
        onOpenStockList={() => setSidebarOpen(true)}
        universeLabel={
          NSE_INDEX_OPTIONS.find((o) => o.id === nseIndex)?.label ?? nseIndex
        }
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
          {/* Timeframe + toolbar row */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <TimeframePills value={timeframe} onChange={setTimeframe} />
            <div style={{ flex: 1, minWidth: 4 }} />
            <DrawingToolbar active={drawingMode} onChange={setDrawingMode} onClear={clearDrawings} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
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
                style={{ accentColor: '#2563eb', margin: 0, width: 14, height: 14 }}
              />
              Highlight Signals
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
          {mode === 'advanced' ? <AdvancedView {...viewProps} /> : <SimpleView {...viewProps} />}
        </>
      )}

      <IndexConstituentsSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        indexLabel={nseIndex}
        nseIndexOptions={NSE_INDEX_OPTIONS}
        selectedNseIndex={nseIndex}
        onNseIndexChange={setNseIndex}
        symbols={constituents}
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
    </div>
  );
}
