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

  return (
    <div>
      <TraderView {...props} />

      {showTimer && (
        <div
          style={{
            marginBottom: 12,
            padding: 16,
            borderRadius: 10,
            border: `2px solid ${timerColor}`,
            background: leftSec < 60 ? '#fef2f2' : '#fff',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 12, color: '#8892a8', marginBottom: 4 }}>Exit timer</div>
          <div
            style={{
              fontSize: 32,
              fontWeight: 800,
              color: timerColor,
              fontFamily: "'SF Mono', Menlo, monospace",
              animation: leftSec < 60 ? 'pulse 1s infinite' : undefined,
            }}
          >
            {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
          </div>
          {leftSec === 0 && (
            <div style={{ marginTop: 8, fontWeight: 800, color: '#dc2626', fontSize: 16 }}>
              EXIT NOW!
            </div>
          )}
          <button
            type="button"
            onClick={stop}
            style={{ ...btn(false), marginTop: 12, minWidth: 120 }}
          >
            Stop timer
          </button>
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#4a5068' }}>
          Exit timer presets
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {[4, 5, 8, 10, 15].map((m) => (
            <button key={m} type="button" style={btn(false)} onClick={() => start(m)}>
              {m}m
            </button>
          ))}
        </div>
      </div>

      {(risk.action === 'BUY' || risk.action === 'SHORT') && !showTimer && (
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
