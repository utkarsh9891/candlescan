export default function Header({ live, lastScan }) {
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: live ? '#16a34a' : '#d97706',
            }}
          />
          <span style={{ color: '#4a5068', fontWeight: 600 }}>
            {live ? 'LIVE' : 'SIMULATED'}
          </span>
        </span>
        {lastScan ? (
          <span style={{ color: '#8892a8', fontSize: 12 }}>
            Scan: {lastScan}
          </span>
        ) : null}
      </div>
    </header>
  );
}
