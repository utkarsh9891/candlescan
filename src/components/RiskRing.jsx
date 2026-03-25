export default function RiskRing({ score, level }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, score)) / 100;
  const offset = c * (1 - pct);
  let col = '#dc2626';
  if (level === 'low') col = '#16a34a';
  else if (level === 'moderate') col = '#d97706';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', margin: '12px 0' }}>
      <svg width={130} height={130} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={65} cy={65} r={r} fill="none" stroke="#eef0f4" strokeWidth={10} />
        <circle
          cx={65}
          cy={65}
          r={r}
          fill="none"
          stroke={col}
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <div
        style={{
          marginTop: -108,
          fontSize: 28,
          fontWeight: 800,
          color: '#1a1d26',
          fontFamily: "'SF Mono', Menlo, monospace",
        }}
      >
        {score}
      </div>
      <div style={{ marginTop: 72, fontSize: 12, color: '#8892a8', fontWeight: 600 }}>
        Risk score
      </div>
    </div>
  );
}
