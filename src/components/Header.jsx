export default function Header({ badge, lastScan, mode, onModeChange, children }) {
  const styles = {
    live: { bg: '#16a34a', label: 'LIVE' },
    demo: { bg: '#d97706', label: 'DEMO' },
    offline: { bg: '#dc2626', label: 'NO DATA' },
    idle: { bg: '#cbd5e1', label: 'READY' },
  };
  const s = styles[badge] || styles.idle;
  const isAdv = mode === 'advanced';

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 14,
        flexWrap: 'wrap',
        gap: 8,
      }}
    >
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1a1d26' }}>
        CandleScan
      </h1>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.bg }} />
          <span style={{ color: '#4a5068', fontWeight: 600 }}>{s.label}</span>
        </span>
        {lastScan ? (
          <span style={{ color: '#8892a8', fontSize: 12 }}>Scan: {lastScan}</span>
        ) : null}

        {/* Simple / Advanced segmented toggle */}
        <div
          style={{
            display: 'inline-flex',
            borderRadius: 999,
            border: '1px solid #e2e5eb',
            background: '#f0f1f4',
            padding: 2,
            gap: 0,
          }}
        >
          {['simple', 'advanced'].map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => onModeChange(m)}
                style={{
                  padding: '3px 10px',
                  fontSize: 10,
                  fontWeight: 700,
                  borderRadius: 999,
                  border: 'none',
                  background: active ? '#fff' : 'transparent',
                  color: active ? '#1a1d26' : '#8892a8',
                  cursor: 'pointer',
                  boxShadow: active ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                  transition: 'all 0.15s',
                  whiteSpace: 'nowrap',
                }}
              >
                {m === 'simple' ? 'Simple' : 'Advanced'}
              </button>
            );
          })}
        </div>

        {children}
      </div>
    </header>
  );
}
