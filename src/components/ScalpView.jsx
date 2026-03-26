import { useEffect, useState } from 'react';
import TraderView from './TraderView.jsx';

const btn = (active) => ({
  minHeight: 40,
  padding: '0 12px',
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 8,
  border: active ? 'none' : '1px solid #e2e5eb',
  background: active ? '#2563eb' : '#fff',
  color: active ? '#fff' : '#4a5068',
  cursor: 'pointer',
});

export default function ScalpView(props) {
  const { risk } = props;
  const [durationMin, setDurationMin] = useState(null);
  const [leftSec, setLeftSec] = useState(null);

  useEffect(() => {
    if (leftSec == null || leftSec <= 0) return undefined;
    const t = setTimeout(() => setLeftSec((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearTimeout(t);
  }, [leftSec]);

  const start = (m) => {
    setDurationMin(m);
    setLeftSec(m * 60);
  };
  const stop = () => {
    setDurationMin(null);
    setLeftSec(null);
  };

  const showTimer = leftSec != null;
  const mm = showTimer ? Math.floor(leftSec / 60) : 0;
  const ss = showTimer ? leftSec % 60 : 0;
  let timerColor = '#16a34a';
  if (leftSec < 60) timerColor = '#dc2626';
  else if (leftSec < 180) timerColor = '#d97706';

  // Timer section rendered separately so App can place it near chart
  const timerSection = (
    <div style={{ marginBottom: 12 }}>
      {showTimer && (
        <div
          style={{
            marginBottom: 8,
            padding: 12,
            borderRadius: 10,
            border: `2px solid ${timerColor}`,
            background: leftSec < 60 ? '#fef2f2' : '#fff',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 12, color: '#8892a8', marginBottom: 2 }}>Exit timer</div>
          <div
            style={{
              fontSize: 28,
              fontWeight: 800,
              color: timerColor,
              fontFamily: "'SF Mono', Menlo, monospace",
              animation: leftSec < 60 ? 'pulse 1s infinite' : undefined,
            }}
          >
            {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
          </div>
          {leftSec === 0 && (
            <div style={{ marginTop: 4, fontWeight: 800, color: '#dc2626', fontSize: 14 }}>
              EXIT NOW!
            </div>
          )}
          <button type="button" onClick={stop} style={{ ...btn(false), marginTop: 8, minWidth: 100, minHeight: 32, fontSize: 12 }}>
            Stop
          </button>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: '#8892a8', fontWeight: 600 }}>Timer:</span>
        {[4, 5, 8, 10, 15].map((m) => (
          <button key={m} type="button" style={{ ...btn(durationMin === m), minHeight: 30, padding: '0 10px', fontSize: 11 }} onClick={() => start(m)}>
            {m}m
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div>
      {/* Timer section placed right after chart (before analysis views) */}
      {timerSection}

      <TraderView {...props} />

      {(risk.action === 'BUY' || risk.action === 'SHORT' || risk.action === 'STRONG BUY' || risk.action === 'STRONG SHORT') && !showTimer && (
        <button
          type="button"
          onClick={() => start(5)}
          style={{
            width: '100%',
            minHeight: 44,
            fontSize: 15,
            fontWeight: 700,
            borderRadius: 10,
            border: 'none',
            background: '#2563eb',
            color: '#fff',
            cursor: 'pointer',
            marginBottom: 12,
          }}
        >
          Start exit timer (5m)
        </button>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.65; }
        }
      `}</style>
    </div>
  );
}
