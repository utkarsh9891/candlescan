import { useState, useEffect } from 'react';
import { getMarketStatus, formatCountdown } from '../utils/marketHours.js';

export default function Header({ onSettings }) {
  const [marketStatus, setMarketStatus] = useState(getMarketStatus);

  useEffect(() => {
    const id = setInterval(() => setMarketStatus(getMarketStatus()), 1000);
    return () => clearInterval(id);
  }, []);

  const isOpen = marketStatus.isOpen;
  const cd = formatCountdown(marketStatus.nextEventMs, marketStatus.nextLabel);
  const cdText = `${marketStatus.nextLabel} ${cd}`;

  return (
    <header className="cs-header">
      <style>{`
        .cs-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 14px;
        }
        .cs-header__brand {
          margin: 0;
          font-size: 20px;
          font-weight: 700;
          color: #1a1d26;
          flex: 0 0 auto;
          line-height: 1.2;
        }
        .cs-header__row {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: nowrap;
          justify-content: flex-end;
          flex: 1 1 auto;
          min-width: 0;
        }
        .cs-header__status {
          display: flex;
          align-items: center;
          gap: 5px;
          font-size: 11px;
          color: #64748b;
          font-weight: 500;
          white-space: nowrap;
          flex-shrink: 0;
        }
        @media (max-width: 480px) {
          .cs-header__brand { font-size: 18px; }
        }
      `}</style>

      <h1 className="cs-header__brand">CandleScan</h1>

      <div className="cs-header__row">
        <span className="cs-header__status">
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: isOpen ? '#16a34a' : '#64748b', flexShrink: 0 }} />
          <span style={{ fontWeight: 700, fontSize: 11, color: isOpen ? '#16a34a' : '#64748b' }}>
            {isOpen ? 'Market Open' : 'Market Closed'}
          </span>
          <span>· {cdText}</span>
        </span>
        {onSettings && (
          <button type="button" onClick={onSettings} aria-label="Settings"
            style={{
              width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 8, border: '1px solid #e2e5eb', background: '#fff', cursor: 'pointer',
              flexShrink: 0, WebkitTapHighlightColor: 'transparent', color: '#4a5068',
            }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        )}
      </div>
    </header>
  );
}
