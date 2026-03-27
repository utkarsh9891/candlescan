import { useState } from 'react';
import RiskRing from './RiskRing.jsx';
import RiskScoreSignals from './RiskScoreSignals.jsx';

const mono = "'SF Mono', Menlo, monospace";

const contextLabels = {
  at_support: { text: 'SUPPORT', color: '#16a34a', bg: '#f0fdf4', desc: 'Price is near recent lows — potential bounce zone' },
  at_resistance: { text: 'RESISTANCE', color: '#dc2626', bg: '#fef2f2', desc: 'Price is near recent highs — potential rejection zone' },
  mid_range: { text: 'MID-RANGE', color: '#8892a8', bg: '#f5f6f8', desc: 'Price is between support and resistance — no clear edge' },
  breakout: { text: 'BREAKOUT', color: '#d97706', bg: '#fffbeb', desc: 'Price has broken out of recent consolidation range' },
};

function actionColor(action) {
  if (action === 'STRONG BUY' || action === 'BUY') return '#16a34a';
  if (action === 'STRONG SHORT' || action === 'SHORT') return '#dc2626';
  if (action === 'WAIT') return '#d97706';
  return '#8892a8';
}

export default function SimpleView({
  sym,
  companyName,
  candles,
  patterns,
  risk,
  changePct,
  activeFilters,
  allPatterns,
}) {
  const [showDetails, setShowDetails] = useState(false);
  const top = patterns.slice(0, 3);
  const confidence = risk.confidence ?? risk.total;
  const last = candles[candles.length - 1];
  const ctx = contextLabels[risk.context] || contextLabels.mid_range;
  const actColor = actionColor(risk.action);

  const identifiedCategories = new Set((allPatterns || patterns).map((p) => p.category));
  const enabledList = activeFilters
    ? Array.from(activeFilters)
    : ['engulfing', 'piercing', 'hammer', 'reversal', 'pullback', 'liquidity', 'momentum', 'indecision'];
  const identifiedCount = enabledList.filter((c) => identifiedCategories.has(c)).length;

  return (
    <div>
      {/* Combined: Price + Action + Score in one compact card */}
      <div style={{
        padding: 16,
        borderRadius: 10,
        border: '1px solid #e2e5eb',
        background: '#fff',
        marginBottom: 10,
      }}>
        {/* Top row: price + change + action */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: '#8892a8', marginBottom: 2 }}>{companyName || sym}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#1a1d26', fontFamily: mono, lineHeight: 1 }}>
              {last?.c?.toFixed(2)}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: changePct >= 0 ? '#16a34a' : '#dc2626', fontFamily: mono }}>
              {changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: actColor, lineHeight: 1.1 }}>
              {risk.action}
            </div>
            <div style={{ fontSize: 11, color: '#8892a8', marginTop: 2 }}>
              R:R {risk.rr.toFixed(1)} · {risk.direction === 'long' ? '▲ Buy' : '▼ Sell'}
            </div>
          </div>
        </div>

        {/* Entry / SL / Target — always shown */}
        <div style={{ display: 'flex', gap: 10, fontSize: 11, fontFamily: mono, color: '#4a5068', marginBottom: 6, flexWrap: 'wrap' }}>
          <div>Entry <strong>{risk.entry.toFixed(2)}</strong></div>
          <div>SL <strong style={{ color: '#dc2626' }}>{risk.sl.toFixed(2)}</strong></div>
          <div>Target <strong style={{ color: '#16a34a' }}>{risk.target.toFixed(2)}</strong></div>
          <div style={{ color: '#8892a8', fontSize: 10 }}>
            {risk.direction === 'long' ? '▲ Buy side' : '▼ Sell side'}
          </div>
        </div>

        {risk.action === 'WAIT' && (
          <div style={{ fontSize: 11, color: '#d97706', marginBottom: 6 }}>Pattern forming — wait for confirmation.</div>
        )}
        {risk.action === 'NO TRADE' && (
          <div style={{ fontSize: 11, color: '#8892a8', marginBottom: 6 }}>No clear signal right now.</div>
        )}

        {/* Badges row: context + confidence */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 4, background: ctx.bg, color: ctx.color, letterSpacing: 0.3 }}>
            {ctx.text}
          </span>
          <RiskRing score={confidence} level={risk.level} />
        </div>
        {ctx.desc && (
          <div style={{ fontSize: 10, color: '#8892a8', lineHeight: 1.4 }}>{ctx.desc}</div>
        )}
      </div>

      {/* Signals + patterns — compact */}
      <div style={{
        padding: 10,
        borderRadius: 10,
        border: '1px solid #e2e5eb',
        background: '#fff',
        marginBottom: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: '#8892a8', fontWeight: 600 }}>
            Signals {identifiedCount}/{enabledList.length}
          </span>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {top.map((p) => (
              <span key={p.name} style={{
                fontSize: 10, padding: '3px 6px', borderRadius: 5,
                background: '#f5f6f8', color: '#4a5068', fontWeight: 600,
              }}>
                {p.emoji} {p.name}
              </span>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {enabledList.map((cat) => {
            const found = identifiedCategories.has(cat);
            return (
              <span key={cat} style={{
                fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 600,
                background: found ? '#eff6ff' : '#f9fafb',
                color: found ? '#2563eb' : '#d1d5db',
                border: `1px solid ${found ? '#bfdbfe' : '#f0f0f0'}`,
              }}>
                {cat}
              </span>
            );
          })}
        </div>
      </div>

      {/* Expandable score details */}
      <button
        type="button"
        onClick={() => setShowDetails((v) => !v)}
        style={{
          width: '100%',
          padding: '8px 0',
          fontSize: 12,
          fontWeight: 600,
          color: '#8892a8',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          marginBottom: 4,
        }}
      >
        {showDetails ? '▾ Hide score details' : '▸ Show score details'}
      </button>
      {showDetails && <RiskScoreSignals breakdown={risk.breakdown} total={risk.total} />}
    </div>
  );
}
