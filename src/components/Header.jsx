import { useState, useEffect } from 'react';
import { getMarketStatus, formatCountdown } from '../utils/marketHours.js';

export default function Header({ children }) {
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
        <span style={{ flexShrink: 0 }}>{children}</span>
      </div>
    </header>
  );
}
