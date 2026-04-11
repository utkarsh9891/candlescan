import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useStockScan } from './hooks/useStockScan.js';
import { useIndexUniverse } from './hooks/useIndexUniverse.js';
import { useAppView } from './hooks/useAppView.js';
import { useScheduledChecks } from './hooks/useScheduledChecks.js';
import ScheduledChecksPanel from './components/ScheduledChecksPanel.jsx';
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
import { getCategoriesForEngine, getRuleCountForEngine } from './data/signalCategories.js';
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

// Session-cache helpers for index constituents are owned by useIndexUniverse.

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

  // Novice Mode: global master switch. When ON, the hamburger's
  // "Index Scanner" action opens a simplified single-button layout
  // (NoviceModePage) instead of the expert BatchScanPage, and the
  // expert page hides jargon + filters. Same scan pipeline under the
  // hood — only the scaffolding changes.
  const [noviceMode, setNoviceMode] = useState(() => {
    try {
      const v = localStorage.getItem('candlescan_novice_mode');
      // Default novice ON for a first-time visitor (safer for the target user).
      // Once they flip the switch, we respect their choice.
      return v == null ? true : v === 'true';
    } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('candlescan_novice_mode', String(noviceMode)); } catch { /* quota */ }
  }, [noviceMode]);

  useEffect(() => {
    try { localStorage.setItem('candlescan_engine', engineVersion); } catch { /* quota */ }
    // Reset signal filters when engine changes (different category sets)
    setActiveFilters(new Set(getCategoriesForEngine(engineVersion)));
    // Auto-set timeframe per engine
    if (engineVersion === 'scalp') setTimeframe('1m');
    else if (engineVersion === 'v2') setTimeframe('5m');
    // Classic: no auto-set (user picks, typically 1d)
  }, [engineVersion]);
  const [timeframe, setTimeframe] = useState(() => {
    try {
      const eng = localStorage.getItem('candlescan_engine') || 'scalp';
      return eng === 'scalp' ? '1m' : '5m';
    } catch { return '5m'; }
  });
  const [inputVal, setInputVal] = useState('');
  const chartRef = useRef(null);
  const [chartInfo, setChartInfo] = useState({ barCount: 0, atMinZoom: false, atMaxZoom: false });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [drawingMode, setDrawingMode] = useState(null);
  const [drawingsMap, setDrawingsMap] = useState({});
  const [highlightSignals, setHighlightSignals] = useState(true);

  const [dataSource, setDataSourceState] = useState(() => {
    try { return localStorage.getItem('candlescan_data_source') || 'yahoo'; } catch { return 'yahoo'; }
  });

  // Index universe: nseIndex + constituents + broad search universe + custom indices
  const {
    nseIndex, setNseIndex,
    customIndices, allIndexOptions,
    handleAddCustomIndex, handleRemoveCustomIndex,
    constituents, constituentsLoading, constituentsError, companyMap,
    broadSearchSymbols, setBroadSearchSymbols,
    broadCompanyMap, setBroadCompanyMap,
    refreshIndex,
  } = useIndexUniverse();

  // Signal filter state (depends on engineVersion, so lives in App)
  const [activeFilters, setActiveFilters] = useState(() => new Set(getCategoriesForEngine(engineVersion)));

  // View routing + back-button handling
  const {
    view, setView,
    cameFromBatch, setCameFromBatch,
    cameFromSimulation, setCameFromSimulation,
    settingsReturnView, setSettingsReturnView,
  } = useAppView();

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

  // When the stock scan discovers a new symbol, grow the broad
  // autocomplete universe so the next search picks it up.
  const handleDiscoverSymbol = useCallback((symbol, name) => {
    if (broadCompanyMap[symbol]) return;
    setBroadSearchSymbols(prev => prev.includes(symbol) ? prev : [...prev, symbol]);
    setBroadCompanyMap(prev => ({ ...prev, [symbol]: name }));
  }, [broadCompanyMap, setBroadSearchSymbols, setBroadCompanyMap]);

  // Stock scan pipeline (runScan, candles, patterns, box, risk,
  // quote, news, history, lazy-prefetch, source fallback chain)
  const {
    sym, companyName, activeSymRef,
    candles, patterns, box, risk,
    loading, simulated, scanError, lastScan,
    yahooSym, lastUsedSource, sourceDebugReason,
    zerodhaExpiredMsg, setZerodhaExpiredMsg,
    quote, stockNews, stockNewsLoading,
    lookbackLevel, loadingMoreHistory,
    runScan, handleLoadMoreHistory,
    history, setHistory,
  } = useStockScan({
    dataSource, setDataSourceState,
    engineVersion, timeframe, nseIndex,
    onDiscoverSymbol: handleDiscoverSymbol,
  });

  // Scheduled Checks — global. Any view can add a schedule via the
  // ScheduleCheckButton component; the hook owns the state + timer
  // loop and fires a single-symbol re-scan at the scheduled time.
  // The panel surfaces the full list regardless of which view the
  // user is currently on.
  const handleOpenSymbol = useCallback((s) => {
    setInputVal(s);
    runScan(s);
    setView('main');
  }, [runScan, setView]);
  const scheduledChecks = useScheduledChecks({ dataSource, nseIndex });

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
          noviceMode={noviceMode}
          onNoviceModeChange={setNoviceMode}
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
        />
      </Header>

      {/* Global Scheduled Checks panel — visible in every view. Shows
          a compact strip when schedules exist; expands to a full list
          on tap. The hook owns the timer + fire logic; this component
          only renders. */}
      <ScheduledChecksPanel
        scheduledChecks={scheduledChecks}
        onOpen={handleOpenSymbol}
      />

      {/* Batch scan view — always mounted, hidden when not active.
          Dispatches between the simplified Novice layout and the
          expert Index Scanner layout based on the noviceMode master
          switch. Both paths run the same batchScan internally. */}
      <div style={{ display: view === 'batch' ? 'block' : 'none' }}>
        {noviceMode ? (
          <NoviceModePage
            savedIndex={nseIndex}
            indexOptions={allIndexOptions}
            dataSource={dataSource}
            onSelectSymbol={(s) => {
              setInputVal(s);
              onQuick(s);
              setView('main');
              setCameFromBatch(true);
            }}
            scheduledChecks={scheduledChecks}
          />
        ) : (
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
            dataSource={dataSource}
            debugMode={debugMode}
            scheduledChecks={scheduledChecks}
          />
        )}
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
          dataSource={dataSource}
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
        onRefresh={refreshIndex}
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
