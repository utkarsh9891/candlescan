import { useEffect, useState } from 'react';
import SimpleView from './SimpleView.jsx';

const mono = "'SF Mono', Menlo, monospace";

const card = {
  padding: 16,
  borderRadius: 10,
  border: '1px solid #e2e5eb',
  background: '#fff',
  marginBottom: 12,
};

const timerBtn = (active) => ({
  minHeight: 28,
  padding: '0 8px',
  fontSize: 11,
  fontWeight: 600,
  borderRadius: 6,
  border: active ? 'none' : '1px solid #e2e5eb',
  background: active ? '#2563eb' : '#fff',
  color: active ? '#fff' : '#4a5068',
  cursor: 'pointer',
});

export default function AdvancedView(props) {
  const { patterns, box, candles, sym, companyName, changePct, risk } = props;
  const last5 = candles.slice(-5);

  /* ── Exit timer (from ScalpView) ─────────────────────────────── */
  const [durationMin, setDurationMin] = useState(null);
  const [leftSec, setLeftSec] = useState(null);

  useEffect(() => {
    if (leftSec == null || leftSec <= 0) return undefined;
    const t = setTimeout(() => setLeftSec((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearTimeout(t);
  }, [leftSec]);

  const startTimer = (m) => { setDurationMin(m); setLeftSec(m * 60); };
  const stopTimer = () => { setDurationMin(null); setLeftSec(null); };

  const showTimer = leftSec != null;
  const mm = showTimer ? Math.floor(leftSec / 60) : 0;
  const ss = showTimer ? leftSec % 60 : 0;
  let timerColor = '#16a34a';
  if (leftSec < 60) timerColor = '#dc2626';
  else if (leftSec < 180) timerColor = '#d97706';

  return (
    <div>
      {/* Core analysis (same as Simple) */}
      <SimpleView {...props} />

      {/* Exit timer */}
      {showTimer && (
        <div
          style={{
            marginBottom: 12,
            padding: 12,
            borderRadius: 10,
            border: `2px solid ${timerColor}`,
            background: leftSec < 60 ? '#fef2f2' : '#fff',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 11, color: '#8892a8', marginBottom: 2 }}>Exit timer</div>
          <div
            style={{
              fontSize: 24,
              fontWeight: 800,
              color: timerColor,
              fontFamily: mono,
              animation: leftSec < 60 ? 'pulse 1s infinite' : undefined,
            }}
          >
            {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
          </div>
          {leftSec === 0 && (
            <div style={{ marginTop: 4, fontWeight: 800, color: '#dc2626', fontSize: 14 }}>EXIT NOW!</div>
          )}
          <button type="button" onClick={stopTimer} style={{ ...timerBtn(false), marginTop: 6 }}>Stop</button>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: '#8892a8', fontWeight: 600 }}>Exit timer:</span>
        {[4, 5, 8, 10, 15].map((m) => (
          <button key={m} type="button" style={timerBtn(durationMin === m)} onClick={() => startTimer(m)}>
            {m}m
          </button>
        ))}
      </div>

      {/* Symbol + change */}
      <div style={{ ...card, fontSize: 13, color: '#4a5068' }}>
        <strong style={{ color: '#1a1d26' }}>{sym}</strong>
        {companyName && companyName !== sym ? ` — ${companyName}` : ''}
        <span style={{ fontFamily: mono, marginLeft: 8, color: changePct >= 0 ? '#16a34a' : '#dc2626' }}>
          Δ {changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%
        </span>
      </div>

      {/* Liquidity box */}
      {box && (
        <div style={card}>
          <div style={{ fontWeight: 700, marginBottom: 8, color: '#1a1d26', fontSize: 13 }}>Liquidity Box</div>
          <div style={{ fontSize: 12, lineHeight: 1.7, fontFamily: mono }}>
            <div>High {box.high.toFixed(2)} — Low {box.low.toFixed(2)}</div>
            <div>Range {box.range.toFixed(3)} · Manip. ±{box.manipulationZone.toFixed(3)}</div>
            <div>
              Breakout:{' '}
              <span style={{ fontWeight: 700, color: box.breakout === 'bullish' ? '#16a34a' : box.breakout === 'bearish' ? '#dc2626' : '#8892a8' }}>
                {box.breakout}
              </span>
            </div>
            <div>
              Trap:{' '}
              <span style={{ fontWeight: 700, color: box.trap !== 'none' ? '#d97706' : '#8892a8' }}>
                {box.trap}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Patterns detail */}
      <div style={card}>
        <div style={{ fontWeight: 700, marginBottom: 8, color: '#1a1d26', fontSize: 13 }}>Patterns</div>
        {patterns.length === 0 && (
          <div style={{ fontSize: 12, color: '#8892a8' }}>No patterns detected (check signal filters)</div>
        )}
        {patterns.map((p) => (
          <div
            key={p.name + p.category}
            style={{ padding: '8px 0', borderBottom: '1px solid #eef0f4', fontSize: 12 }}
          >
            <div style={{ fontWeight: 700 }}>
              {p.emoji} {p.name}{' '}
              <span style={{ color: '#8892a8', fontWeight: 500 }}>({p.category})</span>
              <span style={{ fontFamily: mono, fontSize: 10, marginLeft: 8, color: '#4a5068' }}>
                str:{(p.strength * 100).toFixed(0)}% rel:{(p.reliability * 100).toFixed(0)}%
              </span>
            </div>
            <div style={{ color: '#4a5068', marginTop: 3 }}>{p.description}</div>
          </div>
        ))}
      </div>

      {/* OHLCV table */}
      <div style={card}>
        <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13 }}>Last 5 Candles</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ fontSize: 11, width: '100%', fontFamily: mono, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: '#8892a8' }}>
                <th style={{ textAlign: 'left', padding: '4px 6px' }}>O</th>
                <th style={{ padding: '4px 6px' }}>H</th>
                <th style={{ padding: '4px 6px' }}>L</th>
                <th style={{ padding: '4px 6px' }}>C</th>
                <th style={{ padding: '4px 6px' }}>V</th>
              </tr>
            </thead>
            <tbody>
              {last5.map((c, i) => (
                <tr key={i} style={{ borderTop: '1px solid #eef0f4' }}>
                  <td style={{ padding: '4px 6px' }}>{c.o.toFixed(2)}</td>
                  <td style={{ padding: '4px 6px' }}>{c.h.toFixed(2)}</td>
                  <td style={{ padding: '4px 6px' }}>{c.l.toFixed(2)}</td>
                  <td style={{ padding: '4px 6px' }}>{c.c.toFixed(2)}</td>
                  <td style={{ padding: '4px 6px' }}>{(c.v / 1e3).toFixed(0)}k</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.65; }
        }
      `}</style>
    </div>
  );
}
