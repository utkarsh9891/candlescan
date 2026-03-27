export default function Header({ badge, lastScan, children }) {
  const styles = {
    live: { bg: '#16a34a', label: 'LIVE' },
    demo: { bg: '#d97706', label: 'DEMO' },
    offline: { bg: '#dc2626', label: 'NO DATA' },
    idle: { bg: '#cbd5e1', label: 'READY' },
  };
  const s = styles[badge] || styles.idle;

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
      <h1
        style={{
          margin: 0,
          fontSize: 20,
          fontWeight: 700,
          color: '#1a1d26',
        }}
      >
        CandleScan
      </h1>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: s.bg,
            }}
          />
          <span style={{ color: '#4a5068', fontWeight: 600 }}>{s.label}</span>
        </span>
        {lastScan ? (
          <span style={{ color: '#8892a8', fontSize: 12 }}>
            Scan: {lastScan}
          </span>
        ) : null}
        {children}
      </div>
    </header>
  );
}
