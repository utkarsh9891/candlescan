const mono = "'SF Mono', Menlo, monospace";

export default function RiskRing({ score, level, size = 'default' }) {
  const pct = Math.min(100, Math.max(0, score));
  // high confidence = green, moderate = orange, low = grey
  let col = '#8892a8';
  if (level === 'high') col = '#16a34a';
  else if (level === 'moderate') col = '#d97706';

  const label = level === 'high' ? 'HIGH' : level === 'moderate' ? 'MOD' : 'LOW';
  const lg = size === 'large';

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: lg ? 8 : 6 }}>
      {/* Mini bar chart */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: lg ? 2.5 : 1.5, height: lg ? 26 : 18, flexShrink: 0 }}>
        {Array.from({ length: 8 }, (_, i) => (
          <div
            key={i}
            style={{
              width: lg ? 4.5 : 3,
              height: (lg ? 7 : 5) + (i / 7) * (lg ? 19 : 13),
              borderRadius: lg ? 1.5 : 1,
              background: (i / 8) * 100 < pct ? col : '#e2e5eb',
            }}
          />
        ))}
      </div>
      <span style={{ fontSize: lg ? 20 : 14, fontWeight: 800, color: col, fontFamily: mono }}>{score}</span>
      <span style={{ fontSize: lg ? 11 : 9, fontWeight: 700, color: col, letterSpacing: 0.3 }}>{label}</span>
    </div>
  );
}
