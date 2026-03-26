import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { fetchOHLCV } from './engine/fetcher.js';
import { detectPatterns } from './engine/patterns.js';
import { detectLiquidityBox } from './engine/liquidityBox.js';
import { computeRiskScore } from './engine/risk.js';
import Header from './components/Header.jsx';
import ModeToggle from './components/ModeToggle.jsx';
import TimeframePills from './components/TimeframePills.jsx';
import SearchBar from './components/SearchBar.jsx';
import Chart from './components/Chart.jsx';
import EmptyState from './components/EmptyState.jsx';
import SimpleView from './components/SimpleView.jsx';
import TraderView from './components/TraderView.jsx';
import ScalpView from './components/ScalpView.jsx';
import SignalFilters from './components/SignalFilters.jsx';
import DrawingToolbar from './components/DrawingToolbar.jsx';
import { getRandomQuickStocks } from './data/niftyStocks.js';

const ALL_CATEGORIES = new Set([
  'engulfing', 'piercing', 'hammer', 'reversal', 'pullback', 'liquidity', 'momentum', 'indecision',
]);

const shell = {
  minHeight: '100vh',
  background: '#f5f6f8',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  fontSize: 14,
  color: '#1a1d26',
  padding: '12px 12px 32px',
  maxWidth: 560,
  margin: '0 auto',
  boxSizing: 'border-box',
};

export default function App() {
  const [mode, setMode] = useState('simple');
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
  const activeSymRef = useRef('');

  // Signal filter state
  const [activeFilters, setActiveFilters] = useState(ALL_CATEGORIES);

  // Signal highlight toggle
  const [highlightSignals, setHighlightSignals] = useState(false);

  // Drawing tool state
  const [drawingMode, setDrawingMode] = useState(null);
  const [drawingsMap, setDrawingsMap] = useState({});

  // Random quick stocks from Nifty 100 + Next 100
  const quickStocks = useMemo(() => getRandomQuickStocks(8), []);

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
    if (mode === 'simple' && !['1m', '5m', '15m'].includes(timeframe)) {
      setTimeframe('5m');
    }
  }, [mode, timeframe]);

  const runScan = useCallback(async (symbol) => {
    const s = String(symbol).trim();
    if (!s) return;
    setLoading(true);
    setScanError('');
    try {
      const result = await fetchOHLCV(s, timeframe);
      const { candles: cd, live: lv, simulated: sim, error: err, companyName: cn, displaySymbol } = result;

      activeSymRef.current = displaySymbol;
      setSym(displaySymbol);
      setCompanyName(cn || displaySymbol);
      setSimulated(!!sim);
      setLive(!!lv);

      if (err || !cd?.length) {
        setCandles([]);
        setPatterns([]);
        setBox(null);
        setRisk(null);
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
    if (!activeSymRef.current) return;
    runScan(activeSymRef.current);
  }, [timeframe, runScan]);

  const onQuick = (t) => {
    setInputVal(t);
    runScan(t);
  };

  const onScanClick = () => runScan(inputVal);

  const changePct =
    candles.length >= 2
      ? ((candles[candles.length - 1].c - candles[candles.length - 2].c) /
          Math.max(candles[candles.length - 2].c, 1e-9)) *
        100
      : 0;

  const chartH = mode === 'simple' ? 240 : 300;

  let headerBadge = 'idle';
  if (loading) headerBadge = 'idle';
  else if (scanError) headerBadge = 'offline';
  else if (simulated) headerBadge = 'demo';
  else if (sym && candles.length) headerBadge = live ? 'live' : 'offline';

  // Filter patterns for display (score uses all patterns)
  const filteredPatterns = patterns.filter((p) => activeFilters.has(p.category));

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
      <Header badge={headerBadge} lastScan={lastScan} />
      <ModeToggle mode={mode} onChange={setMode} />
      <TimeframePills mode={mode} value={timeframe} onChange={setTimeframe} />
      <SearchBar inputVal={inputVal} setInputVal={setInputVal} onScan={onScanClick} loading={loading} />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {quickStocks.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onQuick(t)}
            style={{
              minHeight: 36,
              padding: '0 12px',
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 8,
              border: '1px solid #e2e5eb',
              background: '#fff',
              color: '#2563eb',
              cursor: 'pointer',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {loading && (
        <div style={{ height: 4, borderRadius: 2, background: '#e2e5eb', marginBottom: 12, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: '40%', background: '#2563eb', animation: 'csload 0.9s ease-in-out infinite' }} />
        </div>
      )}

      {history.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: '#8892a8', marginBottom: 6 }}>Recent</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {history.map((h) => (
              <button
                key={h.symbol}
                type="button"
                onClick={() => onQuick(h.symbol)}
                style={{
                  minHeight: 36,
                  padding: '0 10px',
                  fontSize: 12,
                  fontWeight: 600,
                  borderRadius: 8,
                  border: '1px solid #e2e5eb',
                  background: '#fff',
                  color: h.riskScore >= 65 ? '#16a34a' : '#8892a8',
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
          {/* Toolbar row: drawing tools + signal filter dropdown + highlight toggle */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <DrawingToolbar active={drawingMode} onChange={setDrawingMode} onClear={clearDrawings} />
            <div style={{ flex: 1 }} />
            <SignalFilters active={activeFilters} onChange={setActiveFilters} />
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
              }}
            >
              <input
                type="checkbox"
                checked={highlightSignals}
                onChange={(e) => setHighlightSignals(e.target.checked)}
                style={{ accentColor: '#2563eb', margin: 0 }}
              />
              Highlight
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
          {mode === 'simple' && <SimpleView {...viewProps} />}
          {mode === 'trader' && <TraderView {...viewProps} />}
          {mode === 'scalp' && <ScalpView {...viewProps} />}
        </>
      )}

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

      <style>{`
        @keyframes csload {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(350%); }
        }
        * { box-sizing: border-box; }
        body { margin: 0; }
      `}</style>
    </div>
  );
}
