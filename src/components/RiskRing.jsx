const mono = "'SF Mono', Menlo, monospace";

export default function RiskRing({ score, level }) {
  const pct = Math.min(100, Math.max(0, score));
  let col = '#dc2626';
  let bgCol = '#fef2f2';
  if (level === 'low') { col = '#16a34a'; bgCol = '#f0fdf4'; }
  else if (level === 'moderate') { col = '#d97706'; bgCol = '#fffbeb'; }

  // Generate mini "chart" bars rising from left to right
  const barCount = 12;
  const bars = [];
  for (let i = 0; i < barCount; i++) {
    const filled = (i / barCount) * 100 < pct;
    const barH = 8 + (i / (barCount - 1)) * 28; // Rising heights from 8 to 36
    bars.push({ h: barH, filled });
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '14px 16px',
      borderRadius: 10,
      border: '1px solid #e2e5eb',
      background: '#fff',
      marginBottom: 12,
    }}>
      {/* Rising bar chart visual */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 40, flexShrink: 0 }}>
        {bars.map((bar, i) => (
          <div
            key={i}
            style={{
              width: 6,
              height: bar.h,
              borderRadius: 2,
              background: bar.filled ? col : '#eef0f4',
              transition: 'background 0.2s',
            }}
          />
        ))}
      </div>

      {/* Score and label */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{
            fontSize: 26,
            fontWeight: 800,
            color: '#1a1d26',
            fontFamily: mono,
            lineHeight: 1,
          }}>
            {score}
          </span>
          <span style={{ fontSize: 12, color: '#8892a8', fontWeight: 600 }}>/ 100</span>
        </div>
        <div style={{ fontSize: 11, color: '#8892a8', fontWeight: 600, marginTop: 2 }}>Confidence</div>
        {/* Linear progress bar */}
        <div style={{
          height: 6,
          borderRadius: 3,
          background: '#eef0f4',
          marginTop: 6,
          overflow: 'hidden',
        }}>
          <div style={{
            width: `${pct}%`,
            height: '100%',
            background: col,
            borderRadius: 3,
            transition: 'width 0.3s',
          }} />
        </div>
      </div>
    </div>
  );
}
