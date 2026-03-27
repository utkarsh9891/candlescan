const mono = "'SF Mono', Menlo, monospace";

export default function RiskRing({ score, level }) {
  const pct = Math.min(100, Math.max(0, score));
  let col = '#dc2626';
  if (level === 'low') col = '#16a34a';
  else if (level === 'moderate') col = '#d97706';

  const label = level === 'low' ? 'LOW' : level === 'moderate' ? 'MOD' : 'HIGH';

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {/* Mini bar chart */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 18, flexShrink: 0 }}>
        {Array.from({ length: 8 }, (_, i) => (
          <div
            key={i}
            style={{
              width: 3,
              height: 5 + (i / 7) * 13,
              borderRadius: 1,
              background: (i / 8) * 100 < pct ? col : '#e2e5eb',
            }}
          />
        ))}
      </div>
      <span style={{ fontSize: 14, fontWeight: 800, color: col, fontFamily: mono }}>{score}</span>
      <span style={{ fontSize: 9, fontWeight: 700, color: col, letterSpacing: 0.3 }}>{label}</span>
    </div>
  );
}
