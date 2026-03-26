import RiskRing from './RiskRing.jsx';
import RiskScoreSignals from './RiskScoreSignals.jsx';

const card = {
  padding: 16,
  borderRadius: 10,
  border: '1px solid #e2e5eb',
  background: '#fff',
  marginBottom: 12,
};

export default function SimpleView({
  sym,
  companyName,
  candles,
  patterns,
  risk,
  changePct,
}) {
  const top = patterns.slice(0, 3);
  const badge =
    risk.level === 'low'
      ? { text: 'LOW RISK', bg: '#f0fdf4', color: '#16a34a' }
      : risk.level === 'moderate'
        ? { text: 'MODERATE', bg: '#fffbeb', color: '#d97706' }
        : { text: 'HIGH RISK ⚠', bg: '#fef2f2', color: '#dc2626' };

  const last = candles[candles.length - 1];
  const actionBg =
    risk.action === 'BUY'
      ? '#f0fdf4'
      : risk.action === 'SHORT'
        ? '#fef2f2'
        : risk.action === 'WAIT'
          ? '#fffbeb'
          : '#f5f6f8';

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

      <RiskRing score={risk.total} level={risk.level} />

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
        {badge.text}
      </div>

      {risk.level === 'high' && (
        <p style={{ fontSize: 13, color: '#dc2626', textAlign: 'center', margin: '0 0 12px' }}>
          Score under 40 — consider skipping this setup.
        </p>
      )}

      <RiskScoreSignals breakdown={risk.breakdown} total={risk.total} />

      <div style={{ ...card, background: actionBg, borderColor: '#e2e5eb' }}>
        <div style={{ fontSize: 12, color: '#8892a8', marginBottom: 6 }}>Action</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: '#1a1d26', marginBottom: 10 }}>
          {risk.action}
        </div>
        {risk.action === 'BUY' || risk.action === 'SHORT' ? (
          <div style={{ fontSize: 13, color: '#4a5068', lineHeight: 1.6, fontFamily: "'SF Mono', Menlo, monospace" }}>
            <div>Entry ~ {risk.entry.toFixed(2)}</div>
            <div>SL {risk.sl.toFixed(2)}</div>
            <div>Target ~ {risk.target.toFixed(2)}</div>
          </div>
        ) : risk.action === 'WAIT' ? (
          <p style={{ margin: 0, fontSize: 13, color: '#4a5068' }}>Pattern forming — wait for confirmation.</p>
        ) : (
          <p style={{ margin: 0, fontSize: 13, color: '#4a5068' }}>No clear signal right now.</p>
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
          </span>
        ))}
      </div>

      <div style={{ height: 8, borderRadius: 4, background: '#eef0f4', overflow: 'hidden' }}>
        <div
          style={{
            width: `${risk.total}%`,
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
