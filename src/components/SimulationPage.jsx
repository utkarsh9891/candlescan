import { useState, useRef, useCallback } from 'react';
import { NSE_INDEX_OPTIONS } from '../config/nseIndices.js';
import { detectPatterns as detectPatternsClassic } from '../engine/patterns-classic.js';
import { detectLiquidityBox as detectLiquidityBoxClassic } from '../engine/liquidityBox-classic.js';
import { computeRiskScore as computeRiskScoreClassic } from '../engine/risk-classic.js';
import { detectPatterns as detectPatternsV2 } from '../engine/patterns-v2.js';
import { detectLiquidityBox as detectLiquidityBoxV2 } from '../engine/liquidityBox-v2.js';
import { computeRiskScore as computeRiskScoreV2 } from '../engine/risk-v2.js';
import { detectPatterns as detectPatternsScalp } from '../engine/patterns-scalp.js';
import { detectLiquidityBox as detectLiquidityBoxScalp } from '../engine/liquidityBox-scalp.js';
import { computeRiskScore as computeRiskScoreScalp } from '../engine/risk-scalp.js';
import { getScalpVariantFns, SCALP_VARIANTS, DEFAULT_SCALP_VARIANT } from '../engine/scalp-variants/registry.js';
import { runSimulation, getLastTradingDay } from '../engine/simulateDay.js';
import { getIndexDirection } from '../engine/indexDirection.js';
import { getBatchToken } from '../utils/batchAuth.js';

const mono = "'SF Mono', Menlo, monospace";

function actionColor(a) {
  if (a === 'STRONG BUY' || a === 'BUY' || a === 'long') return '#16a34a';
  if (a === 'STRONG SHORT' || a === 'SHORT' || a === 'short') return '#dc2626';
  return '#8892a8';
}

function reasonBg(r) {
  if (r === 'TARGET') return '#f0fdf4';
  if (r === 'SL') return '#fef2f2';
  return '#f5f6f8';
}
function reasonColor(r) {
  if (r === 'TARGET') return '#16a34a';
  if (r === 'SL') return '#dc2626';
  return '#8892a8';
}

function TradeCard({ t, onTap }) {
  const pnlColor = t.netPnl >= 0 ? '#16a34a' : '#dc2626';
  return (
    <button
      type="button"
      onClick={() => onTap(t.sym)}
      style={{
        width: '100%', textAlign: 'left', cursor: 'pointer',
        padding: 12, borderRadius: 10, border: '1px solid #e2e5eb', background: '#fff',
        display: 'block', marginBottom: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>{t.sym}</span>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
          background: t.direction === 'long' ? '#f0fdf4' : '#fef2f2',
          color: actionColor(t.direction),
        }}>
          {t.direction === 'long' ? 'LONG' : 'SHORT'}
        </span>
        <span style={{
          fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
          background: reasonBg(t.reason), color: reasonColor(t.reason),
        }}>
          {t.reason}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 14, fontWeight: 700, fontFamily: mono, color: pnlColor }}>
          {t.netPnl >= 0 ? '+' : ''}{t.netPnl.toFixed(0)}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: '#4a5068' }}>
        <span style={{ fontFamily: mono }}>
          {t.entry.toFixed(1)} → {t.exit.toFixed(1)}
        </span>
        <span style={{ color: '#8892a8' }}>{t.shares} sh</span>
        <span style={{ color: '#8892a8' }}>{t.entryTime}–{t.exitTime}</span>
        <span style={{ marginLeft: 'auto', color: '#8892a8', fontStyle: 'italic' }}>
          {t.pattern} ({t.confidence})
        </span>
      </div>
    </button>
  );
}

// Engine-specific defaults
const ENGINE_PRESETS = {
  scalp:  { from: '09:30', to: '11:00', maxOpen: 1, maxTrades: 5 },
  v2:     { from: '09:15', to: '14:30', maxOpen: 2, maxTrades: 3 },
  v1:     { from: '09:15', to: '15:30', maxOpen: 3, maxTrades: 2 },
};

export default function SimulationPage({ onSelectSymbol, savedIndex, indexOptions, engineVersion, scalpVariant: parentVariant, onScalpVariantChange }) {
  const allOptions = indexOptions || NSE_INDEX_OPTIONS;
  const [localEngine, setLocalEngine] = useState(engineVersion || 'scalp');
  const [localVariant, setLocalVariant] = useState(parentVariant || DEFAULT_SCALP_VARIANT);
  const preset = ENGINE_PRESETS[localEngine] || ENGINE_PRESETS.scalp;
  const [date, setDate] = useState(getLastTradingDay);
  const [startTime, setStartTime] = useState(preset.from);
  const [endTime, setEndTime] = useState(preset.to);
  const [nseIndex, setNseIndex] = useState('NIFTY SMALLCAP 100');
  const [capital, setCapital] = useState(300000);
  const [positionSize, setPositionSize] = useState(300000);
  const [maxConcurrent, setMaxConcurrent] = useState(preset.maxOpen);
  const [maxTotalTrades, setMaxTotalTrades] = useState(preset.maxTrades);

  // Update presets when engine changes
  const handleEngineChange = (eng) => {
    setLocalEngine(eng);
    const p = ENGINE_PRESETS[eng] || ENGINE_PRESETS.scalp;
    setStartTime(p.from);
    setEndTime(p.to);
    setMaxConcurrent(p.maxOpen);
    setMaxTotalTrades(p.maxTrades);
  };
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ phase: '', completed: 0, total: 0, current: '' });
  const [results, setResults] = useState(null); // { trades, summary }
  const [error, setError] = useState('');
  const abortRef = useRef(null);

  const handleRun = useCallback(async () => {
    if (running) { abortRef.current?.abort(); return; }

    // Validation
    if (positionSize * maxConcurrent > capital) {
      setError(`Position size (${(positionSize/1000).toFixed(0)}K) × max concurrent (${maxConcurrent}) exceeds capital (${(capital/100000).toFixed(0)}L)`);
      return;
    }

    setRunning(true);
    setError('');
    setResults(null);

    const controller = new AbortController();
    abortRef.current = controller;

    let engineFns;
    if (localEngine === 'scalp') {
      engineFns = getScalpVariantFns(localVariant);
    } else if (localEngine === 'v2') {
      engineFns = { detectPatterns: detectPatternsV2, detectLiquidityBox: detectLiquidityBoxV2, computeRiskScore: computeRiskScoreV2 };
    } else {
      engineFns = { detectPatterns: detectPatternsClassic, detectLiquidityBox: detectLiquidityBoxClassic, computeRiskScore: computeRiskScoreClassic };
    }

    try {
      // Compute index direction for scalp engine (matches CLI behavior)
      let idxDir = null;
      if (localEngine === 'scalp') {
        try { idxDir = await getIndexDirection(nseIndex); } catch { /* ignore */ }
      }

      const simTimeframe = localEngine === 'scalp' ? '1m' : '5m';
      const res = await runSimulation({
        indexName: nseIndex,
        timeframe: simTimeframe,
        date, startTime, endTime,
        engineFns,
        indexDirection: idxDir,
        capital, positionSize, maxConcurrent, maxTotalTrades,
        batchToken: getBatchToken(),
        onProgress: (phase, completed, total, current) => {
          setProgress({ phase, completed, total, current });
        },
        signal: controller.signal,
      });
      setResults(res);
    } catch (e) {
      if (e?.name !== 'AbortError') setError(e?.message || String(e));
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [running, date, startTime, endTime, nseIndex, localEngine, capital, positionSize, maxConcurrent, maxTotalTrades]);

  const pct = progress.total > 0 ? (progress.completed / progress.total) * 100 : 0;
  const s = results?.summary;

  const inputStyle = {
    padding: '8px 10px', fontSize: 13, borderRadius: 6,
    border: '1px solid #e2e5eb', outline: 'none', boxSizing: 'border-box',
    color: '#1a1d26', background: '#fff',
  };
  const labelStyle = { fontSize: 10, color: '#8892a8', fontWeight: 600, marginBottom: 2 };

  return (
    <div>
      {/* 1. Engine selector (primary — determines all other defaults) */}
      <div style={{ marginBottom: 10 }}>
        <div style={labelStyle}>Engine</div>
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            { k: 'scalp', l: 'Scalp', color: '#d97706' },
            { k: 'v2', l: 'Intraday', color: '#2563eb' },
            { k: 'v1', l: 'Classic', color: '#16a34a' },
          ].map(v => (
            <button key={v.k} type="button" disabled={running} onClick={() => handleEngineChange(v.k)}
              style={{
                flex: 1, padding: '10px 0', fontSize: 12, fontWeight: 700, borderRadius: 8,
                border: localEngine === v.k ? 'none' : '1px solid #e2e5eb',
                background: localEngine === v.k ? v.color : '#fff',
                color: localEngine === v.k ? '#fff' : '#4a5068',
                cursor: running ? 'not-allowed' : 'pointer',
              }}>
              {v.l}
            </button>
          ))}
        </div>
      </div>

      {/* 1b. Scalp variant selector */}
      {localEngine === 'scalp' && (
        <div style={{ marginBottom: 10 }}>
          <div style={labelStyle}>Scalp Variant</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {SCALP_VARIANTS.map(v => (
              <button key={v.key} type="button" disabled={running}
                title={v.description}
                onClick={() => { setLocalVariant(v.key); if (onScalpVariantChange) onScalpVariantChange(v.key); }}
                style={{
                  padding: '6px 10px', fontSize: 10, fontWeight: 700, borderRadius: 6,
                  border: localVariant === v.key ? 'none' : '1px solid #e2e5eb',
                  background: localVariant === v.key ? v.color : '#fff',
                  color: localVariant === v.key ? '#fff' : '#4a5068',
                  cursor: running ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
                }}>
                {v.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 2. Date + Time window */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 120px' }}>
          <div style={labelStyle}>Date</div>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            disabled={running} style={{ ...inputStyle, width: '100%' }} />
        </div>
        <div style={{ flex: '0 0 80px' }}>
          <div style={labelStyle}>From</div>
          <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}
            disabled={running} style={{ ...inputStyle, width: '100%' }} />
        </div>
        <div style={{ flex: '0 0 80px' }}>
          <div style={labelStyle}>To</div>
          <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)}
            disabled={running} style={{ ...inputStyle, width: '100%' }} />
        </div>
      </div>

      {/* 3. Index */}
      <div style={{ marginBottom: 10 }}>
        <div style={labelStyle}>Index</div>
        <select value={nseIndex} onChange={e => setNseIndex(e.target.value)}
          disabled={running} style={{ ...inputStyle, width: '100%', cursor: 'pointer' }}>
          {allOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </div>

      {/* Trade parameters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 80px' }}>
          <div style={labelStyle}>Capital</div>
          <input type="number" value={capital || ''} onChange={e => setCapital(e.target.value === '' ? '' : +e.target.value)}
            onBlur={e => { if (!e.target.value) setCapital(300000); }}
            step={50000} min={50000} disabled={running} style={{ ...inputStyle, width: '100%' }} />
        </div>
        <div style={{ flex: '1 1 80px' }}>
          <div style={labelStyle}>Per Trade</div>
          <input type="number" value={positionSize || ''} onChange={e => setPositionSize(e.target.value === '' ? '' : +e.target.value)}
            onBlur={e => { if (!e.target.value) setPositionSize(300000); }}
            step={50000} min={10000} disabled={running} style={{ ...inputStyle, width: '100%' }} />
        </div>
        <div style={{ flex: '0 0 60px' }}>
          <div style={labelStyle}>Max Open</div>
          <input type="number" value={maxConcurrent || ''} onChange={e => setMaxConcurrent(e.target.value === '' ? '' : +e.target.value)}
            onBlur={e => { if (!e.target.value) setMaxConcurrent(1); }}
            min={1} max={5} disabled={running} style={{ ...inputStyle, width: '100%' }} />
        </div>
        <div style={{ flex: '0 0 60px' }}>
          <div style={labelStyle}>Max Trades</div>
          <input type="number" value={maxTotalTrades || ''} onChange={e => setMaxTotalTrades(e.target.value === '' ? '' : +e.target.value)}
            onBlur={e => { if (!e.target.value) setMaxTotalTrades(5); }}
            min={1} max={15} disabled={running} style={{ ...inputStyle, width: '100%' }} />
        </div>
      </div>

      {/* Run button */}
      <button type="button" onClick={handleRun}
        style={{
          width: '100%', padding: '12px 0', fontSize: 14, fontWeight: 700,
          borderRadius: 10, border: 'none', cursor: 'pointer',
          background: running ? '#dc2626' : '#2563eb', color: '#fff', marginBottom: 12,
        }}>
        {running ? `Cancel (${progress.phase}: ${progress.completed}/${progress.total})` : 'Run Simulation'}
      </button>

      {/* Progress */}
      {running && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ height: 6, borderRadius: 3, background: '#e2e5eb', overflow: 'hidden', marginBottom: 4 }}>
            <div style={{ height: '100%', width: `${pct}%`, background: '#2563eb', borderRadius: 3, transition: 'width 0.3s' }} />
          </div>
          <div style={{ fontSize: 11, color: '#8892a8' }}>{progress.phase}... {progress.current}</div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ padding: 12, borderRadius: 10, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* Summary */}
      {s && (
        <div style={{
          padding: 14, borderRadius: 10, border: '1px solid #e2e5eb', background: '#fff', marginBottom: 12,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>
            Simulation — {s.date} ({s.stocksScanned} stocks)
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 12, fontFamily: mono, color: '#4a5068' }}>
            <div>
              <div style={labelStyle}>Trades</div>
              <strong>{s.totalTrades}</strong> ({s.wins}W / {s.losses}L)
            </div>
            <div>
              <div style={labelStyle}>Win Rate</div>
              <strong>{s.winRate.toFixed(1)}%</strong>
            </div>
            <div>
              <div style={labelStyle}>P&L</div>
              <strong style={{ color: s.totalPnl >= 0 ? '#16a34a' : '#dc2626' }}>
                {s.totalPnl >= 0 ? '+' : ''}Rs.{s.totalPnl.toFixed(0)}
              </strong>
            </div>
            <div>
              <div style={labelStyle}>Return</div>
              <strong style={{ color: s.returnPct >= 0 ? '#16a34a' : '#dc2626' }}>
                {s.returnPct >= 0 ? '+' : ''}{s.returnPct.toFixed(2)}%
              </strong>
            </div>
            <div>
              <div style={labelStyle}>Drawdown</div>
              <strong style={{ color: '#dc2626' }}>Rs.{s.maxDrawdown.toFixed(0)}</strong>
            </div>
            <div>
              <div style={labelStyle}>Tx Cost</div>
              Rs.{s.totalTxCost.toFixed(0)}
            </div>
          </div>
        </div>
      )}

      {/* Trade log */}
      {results?.trades?.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#4a5068', marginBottom: 8 }}>
            {results.trades.length} trades
          </div>
          {results.trades.map((t, i) => (
            <TradeCard key={`${t.sym}-${i}`} t={t} onTap={onSelectSymbol} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!running && !results && !error && (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: '#8892a8' }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>&#x1F4CA;</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Trading Simulation</div>
          <div style={{ fontSize: 12, lineHeight: 1.5 }}>
            Backtest the signal engine on historical data. Pick a date, time window,
            and index, then run a bar-by-bar simulation with no future knowledge.
          </div>
        </div>
      )}
    </div>
  );
}
