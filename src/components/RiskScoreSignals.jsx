import { RISK_SIGNAL_DEFINITIONS } from '../engine/risk.js';

const card = {
  padding: 16,
  borderRadius: 10,
  border: '1px solid #e2e5eb',
  background: '#fff',
  marginBottom: 12,
};

const mono = "'SF Mono', Menlo, monospace";

export default function RiskScoreSignals({ breakdown, total }) {
  if (!breakdown) return null;

  return (
    <div style={card}>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4, color: '#1a1d26' }}>
        Signal scores
      </div>
      <p style={{ margin: '0 0 14px', fontSize: 12, color: '#8892a8', lineHeight: 1.5 }}>
        Each row is one input to the composite risk score (0–100). Points are summed, then capped at
        100.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto auto',
          gap: '8px 10px',
          alignItems: 'center',
          fontSize: 12,
          marginBottom: 18,
        }}
      >
        <div style={{ fontWeight: 700, color: '#8892a8', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
          Signal
        </div>
        <div
          style={{
            fontWeight: 700,
            color: '#8892a8',
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
            textAlign: 'right',
          }}
        >
          Score
        </div>
        <div
          style={{
            fontWeight: 700,
            color: '#8892a8',
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
            textAlign: 'right',
          }}
        >
          Weight
        </div>

        {RISK_SIGNAL_DEFINITIONS.map((def) => {
          const v = Number(breakdown[def.key]) || 0;
          const wPct = Math.round((def.max / 100) * 1000) / 10;
          return (
            <div key={def.key} style={{ gridColumn: '1 / -1', display: 'contents' }}>
              <div style={{ color: '#1a1d26', fontWeight: 600, lineHeight: 1.35 }}>{def.label}</div>
              <div
                style={{
                  textAlign: 'right',
                  fontFamily: mono,
                  fontWeight: 600,
                  color: '#4a5068',
                }}
              >
                {v} / {def.max}
              </div>
              <div style={{ textAlign: 'right', fontFamily: mono, color: '#8892a8' }}>{wPct}%</div>
            </div>
          );
        })}
      </div>

      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          marginBottom: 10,
          color: '#1a1d26',
          paddingTop: 14,
          borderTop: '1px solid #eef0f4',
        }}
      >
        What each signal means
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {RISK_SIGNAL_DEFINITIONS.map((def) => (
          <li
            key={def.key}
            style={{
              marginBottom: 12,
              paddingBottom: 12,
              borderBottom: '1px solid #f0f2f6',
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 13, color: '#2563eb', marginBottom: 4 }}>
              {def.label}{' '}
              <span style={{ color: '#8892a8', fontWeight: 600, fontFamily: mono, fontSize: 12 }}>
                (max {def.max})
              </span>
            </div>
            <div style={{ fontSize: 13, color: '#4a5068', lineHeight: 1.55 }}>{def.meaning}</div>
          </li>
        ))}
      </ul>

      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          marginBottom: 10,
          color: '#1a1d26',
          paddingTop: 8,
        }}
      >
        How the final score is combined
      </div>
      <div
        style={{
          fontSize: 12,
          color: '#4a5068',
          lineHeight: 1.65,
          fontFamily: mono,
          background: '#f5f6f8',
          padding: 12,
          borderRadius: 8,
          border: '1px solid #eef0f4',
        }}
      >
        <div style={{ marginBottom: 10, color: '#1a1d26', fontWeight: 600, fontFamily: 'inherit' }}>
          Additive (implemented)
        </div>
        <div>
          raw = S<sub style={{ fontSize: 10 }}>clarity</sub> + S<sub style={{ fontSize: 10 }}>noise</sub>{' '}
          + S<sub style={{ fontSize: 10 }}>rr</sub> + S<sub style={{ fontSize: 10 }}>pattern</sub> + S
          <sub style={{ fontSize: 10 }}>conf</sub>
        </div>
        <div style={{ marginTop: 6 }}>riskScore = min(100, round(raw))</div>
        <div style={{ marginTop: 10, fontSize: 11, color: '#8892a8', fontFamily: 'system-ui, sans-serif' }}>
          Headline score shown in the ring: <strong style={{ color: '#1a1d26' }}>{total}</strong> (same
          inputs; grid values are rounded per row for readability).
        </div>

        <div style={{ margin: '14px 0 8px', color: '#1a1d26', fontWeight: 600, fontFamily: 'system-ui, sans-serif' }}>
          Same thing as a weighted average of utilization
        </div>
        <div>
          f<sub style={{ fontSize: 10 }}>k</sub> = (points for signal k) / (max for k), &nbsp;w
          <sub style={{ fontSize: 10 }}>k</sub> = (max for k) / 100
        </div>
        <div style={{ marginTop: 6 }}>riskScore = min(100, round(100 × Σ w<sub style={{ fontSize: 10 }}>k</sub> f<sub style={{ fontSize: 10 }}>k</sub>))</div>
        <div style={{ marginTop: 8, fontSize: 11, color: '#8892a8', fontFamily: 'system-ui, sans-serif', lineHeight: 1.5 }}>
          Weights match each signal’s share of the 100-point budget: 25%, 20%, 25%, 15%, 15%. Because w
          <sub style={{ fontSize: 10 }}>k</sub> ∝ max<sub style={{ fontSize: 10 }}>k</sub>, this equals the raw sum
          before the cap.
        </div>
      </div>
    </div>
  );
}
