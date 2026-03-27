export default function Header({ badge, lastScan, mode, onModeChange, children }) {
  const styles = {
    live: { bg: '#16a34a', label: 'LIVE' },
    demo: { bg: '#d97706', label: 'DEMO' },
    offline: { bg: '#dc2626', label: 'NO DATA' },
    idle: { bg: '#cbd5e1', label: 'READY' },
  };
  const s = styles[badge] || styles.idle;

  return (
    <header className="cs-header">
      <style>{`
        .cs-header {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 14px;
          row-gap: 10px;
        }
        .cs-header__brand {
          margin: 0;
          font-size: 20px;
          font-weight: 700;
          color: #1a1d26;
          flex: 0 1 auto;
          min-width: 0;
          line-height: 1.2;
        }
        .cs-header__row {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          justify-content: flex-end;
          flex: 1 1 auto;
          min-width: 0;
        }
        .cs-header__meta {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 13px;
          color: #4a5068;
          font-weight: 600;
          white-space: nowrap;
          flex-shrink: 0;
        }
        .cs-header__scan {
          color: #8892a8;
          font-size: 12px;
          font-weight: 500;
          max-width: 140px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .cs-header__modes {
          display: inline-flex;
          border-radius: 999px;
          border: 1px solid #e2e5eb;
          background: #f0f1f4;
          padding: 2px;
          gap: 0;
          flex-shrink: 0;
        }
        .cs-header__modes button {
          padding: 6px 12px;
          font-size: 11px;
          font-weight: 700;
          border-radius: 999px;
          border: none;
          background: transparent;
          color: #8892a8;
          cursor: pointer;
          white-space: nowrap;
          -webkit-tap-highlight-color: transparent;
        }
        .cs-header__modes button[data-active="true"] {
          background: #fff;
          color: #1a1d26;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        @media (max-width: 480px) {
          .cs-header {
            flex-direction: column;
            align-items: stretch;
          }
          .cs-header__brand {
            font-size: 18px;
            width: 100%;
          }
          .cs-header__row {
            justify-content: space-between;
            width: 100%;
          }
          .cs-header__scan {
            display: none;
          }
        }
      `}</style>

      <h1 className="cs-header__brand">CandleScan</h1>

      <div className="cs-header__row">
        <span className="cs-header__meta">
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.bg, flexShrink: 0 }} />
          <span>{s.label}</span>
        </span>
        {lastScan ? (
          <span className="cs-header__scan" title={`Scan: ${lastScan}`}>
            Scan: {lastScan}
          </span>
        ) : null}

        <div className="cs-header__modes">
          {['simple', 'advanced'].map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                data-active={active}
                onClick={() => onModeChange(m)}
              >
                {m === 'simple' ? 'Simple' : 'Advanced'}
              </button>
            );
          })}
        </div>

        <span style={{ flexShrink: 0 }}>{children}</span>
      </div>
    </header>
  );
}
