import { useState, useCallback, useEffect, useRef } from 'react';
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

const QUICK = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'SBIN', 'ITC', 'TATAMOTORS', 'WIPRO'];

const shell = {
  minHeight: '100vh',
  background: '#f5f6f8',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  fontSize: 14,
  color: '#1a1d26',
  padding: '12px 12px 32px',
  maxWidth: 480,
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
  const [live, setLive] = useState(true);
  const [candles, setCandles] = useState([]);
  const [patterns, setPatterns] = useState([]);
  const [box, setBox] = useState(null);
  const [risk, setRisk] = useState(null);
  const [history, setHistory] = useState([]);
  const [lastScan, setLastScan] = useState('');
  const activeSymRef = useRef('');

  useEffect(() => {
    if (mode === 'simple' && !['1m', '5m', '15m'].includes(timeframe)) {
      setTimeframe('5m');
    }
  }, [mode, timeframe]);

  const runScan = useCallback(async (symbol) => {
    const s = String(symbol).trim();
    if (!s) return;
    setLoading(true);
    try {
      const { candles: cd, live: lv, companyName: cn, displaySymbol } = await fetchOHLCV(
        s,
        timeframe
      );
      activeSymRef.current = displaySymbol;
      setSym(displaySymbol);
      setCandles(cd);
      setLive(lv);
      setCompanyName(cn || displaySymbol);
      const pat = detectPatterns(cd);
      const bx = detectLiquidityBox(cd);
      const rk = computeRiskScore({ candles: cd, patterns: pat, box: bx });
      setPatterns(pat);
      setBox(bx);
      setRisk(rk);
      setLastScan(new Date().toLocaleTimeString());
      setHistory((h) => {
        const next = [
          { symbol: displaySymbol, riskScore: rk.total },
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

  const chartH = mode === 'simple' ? 140 : 175;

  const viewProps = {
    sym,
    companyName,
    candles,
    patterns,
    risk,
    box,
    changePct,
  };

  return (
    <div style={shell}>
      <Header live={live} lastScan={lastScan} />
      <ModeToggle mode={mode} onChange={setMode} />
      <TimeframePills mode={mode} value={timeframe} onChange={setTimeframe} />
      <SearchBar
        inputVal={inputVal}
        setInputVal={setInputVal}
        onScan={onScanClick}
        loading={loading}
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {QUICK.map((t) => (
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
        <div
          style={{
            height: 4,
            borderRadius: 2,
            background: '#e2e5eb',
            marginBottom: 12,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: '40%',
              background: '#2563eb',
              animation: 'csload 0.9s ease-in-out infinite',
            }}
          />
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
                  color: h.riskScore >= 60 ? '#16a34a' : '#8892a8',
                  cursor: 'pointer',
                }}
              >
                {h.symbol} ({h.riskScore})
              </button>
            ))}
          </div>
        </div>
      )}

      {!sym || !risk ? (
        <EmptyState />
      ) : (
        <>
          <Chart candles={candles} box={box} height={chartH} />
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
        {!live && (
          <p style={{ margin: '0 0 8px' }}>
            Simulated data — Yahoo Finance was unreachable from this browser. For live OHLCV, try
            another network or deploy to GitHub Pages.
          </p>
        )}
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
