import RiskRing from './RiskRing.jsx';
import RiskScoreSignals from './RiskScoreSignals.jsx';

const card = {
  padding: 16,
  borderRadius: 10,
  border: '1px solid #e2e5eb',
  background: '#fff',
  marginBottom: 12,
};

const contextLabels = {
  at_support: { text: 'AT SUPPORT', color: '#16a34a', bg: '#f0fdf4' },
  at_resistance: { text: 'AT RESISTANCE', color: '#dc2626', bg: '#fef2f2' },
  mid_range: { text: 'MID-RANGE', color: '#8892a8', bg: '#f5f6f8' },
  breakout: { text: 'BREAKOUT', color: '#d97706', bg: '#fffbeb' },
};

function actionStyle(action) {
  if (action === 'STRONG BUY') return { bg: '#f0fdf4', color: '#16a34a' };
  if (action === 'BUY') return { bg: '#f0fdf4', color: '#16a34a' };
  if (action === 'STRONG SHORT') return { bg: '#fef2f2', color: '#dc2626' };
  if (action === 'SHORT') return { bg: '#fef2f2', color: '#dc2626' };
  if (action === 'WAIT') return { bg: '#fffbeb', color: '#d97706' };
  return { bg: '#f5f6f8', color: '#8892a8' };
}

export default function SimpleView({
  sym,
  companyName,
  candles,
  patterns,
  risk,
  changePct,
}) {
  const top = patterns.slice(0, 3);
  const confidence = risk.confidence ?? risk.total;

  const badge =
    risk.level === 'low'
      ? { text: 'LOW RISK', bg: '#f0fdf4', color: '#16a34a' }
      : risk.level === 'moderate'
        ? { text: 'MODERATE', bg: '#fffbeb', color: '#d97706' }
        : { text: 'HIGH RISK', bg: '#fef2f2', color: '#dc2626' };

  const last = candles[candles.length - 1];
  const actStyle = actionStyle(risk.action);
  const ctx = contextLabels[risk.context] || contextLabels.mid_range;

  return (
    <div>
      <div style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontSize: 13, color: '#8892a8' }}>{companyName || sym}</div>
        <div
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: '#1a1d26',
            fontFamily: "'SF Mono', Menlo, monospace",
          }}
        >
          {last?.c?.toFixed(2)}
        </div>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: changePct >= 0 ? '#16a34a' : '#dc2626',
            fontFamily: "'SF Mono', Menlo, monospace",
          }}
        >
          {changePct >= 0 ? '+' : ''}
          {changePct.toFixed(2)}%
        </div>
      </div>

      <RiskRing score={confidence} level={risk.level} />

      {/* Context badge */}
      <div
        style={{
          textAlign: 'center',
          marginBottom: 8,
          padding: '5px 10px',
          borderRadius: 6,
          background: ctx.bg,
          color: ctx.color,
          fontWeight: 700,
          fontSize: 11,
          letterSpacing: 0.5,
          display: 'inline-block',
          marginLeft: '50%',
          transform: 'translateX(-50%)',
        }}
      >
        {ctx.text}
      </div>

      <div
        style={{
          textAlign: 'center',
          marginBottom: 12,
          padding: '8px 12px',
          borderRadius: 8,
          background: badge.bg,
          color: badge.color,
          fontWeight: 800,
          fontSize: 13,
          letterSpacing: 0.5,
        }}
      >
        {badge.text} · Confidence {confidence}%
      </div>

      <RiskScoreSignals breakdown={risk.breakdown} total={risk.total} />

      {/* Action card with Entry/SL/Target */}
      <div style={{ ...card, background: actStyle.bg, borderColor: '#e2e5eb' }}>
        <div style={{ fontSize: 12, color: '#8892a8', marginBottom: 6 }}>Action</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: '#1a1d26', marginBottom: 10 }}>
          {risk.action}
        </div>
        <div style={{ fontSize: 13, color: '#4a5068', lineHeight: 1.8, fontFamily: "'SF Mono', Menlo, monospace" }}>
          <div>
            Entry ~ <strong>{risk.entry.toFixed(2)}</strong>
          </div>
          <div>
            SL <strong style={{ color: '#dc2626' }}>{risk.sl.toFixed(2)}</strong>
            <span style={{ color: '#8892a8', fontSize: 11, marginLeft: 6 }}>
              ({Math.abs(risk.entry - risk.sl).toFixed(2)} pts)
            </span>
          </div>
          <div>
            Target ~ <strong style={{ color: '#16a34a' }}>{risk.target.toFixed(2)}</strong>
            <span style={{ color: '#8892a8', fontSize: 11, marginLeft: 6 }}>
              ({Math.abs(risk.target - risk.entry).toFixed(2)} pts)
            </span>
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: '#8892a8' }}>
            R:R {risk.rr.toFixed(1)} · {risk.direction === 'long' ? '▲ Long' : '▼ Short'}
          </div>
        </div>
        {risk.action === 'WAIT' && (
          <p style={{ margin: '8px 0 0', fontSize: 13, color: '#4a5068' }}>Pattern forming — wait for confirmation candle.</p>
        )}
        {risk.action === 'NO TRADE' && (
          <p style={{ margin: '8px 0 0', fontSize: 13, color: '#4a5068' }}>No clear signal right now. Consider skipping.</p>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {top.map((p) => (
          <span
            key={p.name}
            style={{
              fontSize: 12,
              padding: '6px 10px',
              borderRadius: 8,
              background: '#f5f6f8',
              color: '#4a5068',
              fontWeight: 600,
            }}
          >
            {p.emoji} {p.name}
            {p.terminationRisk && p.terminationRisk !== 'low' && (
              <span style={{ color: p.terminationRisk === 'high' ? '#dc2626' : '#d97706', marginLeft: 4, fontSize: 10 }}>
                ({p.terminationRisk} exhaustion)
              </span>
            )}
          </span>
        ))}
      </div>

      <div style={{ height: 8, borderRadius: 4, background: '#eef0f4', overflow: 'hidden' }}>
        <div
          style={{
            width: `${confidence}%`,
            height: '100%',
            background:
              risk.level === 'low' ? '#16a34a' : risk.level === 'moderate' ? '#d97706' : '#dc2626',
            borderRadius: 4,
          }}
        />
      </div>
    </div>
  );
}
