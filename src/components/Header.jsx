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

        {/* Simple / Advanced toggle */}
        <button
          type="button"
          onClick={() => onModeChange(isAdv ? 'simple' : 'advanced')}
          aria-label={`Switch to ${isAdv ? 'simple' : 'advanced'} mode`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 10px',
            fontSize: 11,
            fontWeight: 700,
            borderRadius: 999,
            border: '1px solid #e2e5eb',
            background: isAdv ? '#2563eb' : '#fff',
            color: isAdv ? '#fff' : '#4a5068',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            transition: 'all 0.15s',
          }}
        >
          {isAdv ? 'Advanced' : 'Simple'}
        </button>

        {children}
      </div>
    </header>
  );
}
