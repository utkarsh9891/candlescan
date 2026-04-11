import { useState } from 'react';
import RiskRing from './RiskRing.jsx';
import RiskScoreSignals from './RiskScoreSignals.jsx';
import { SIGNAL_CATEGORIES } from '../data/signalCategories.js';

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
  viewMode = 'simple',
  signalMeta = { categoryCount: SIGNAL_CATEGORIES.length, rulesApprox: 46 },
  beforeScoreDetails,
}) {
  const [showDetails, setShowDetails] = useState(false);
  const isAdvanced = viewMode === 'advanced';
  const top = patterns.slice(0, isAdvanced ? 3 : 2);
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
          <div style={{ flex: 1, minWidth: 0, marginRight: 8 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: '#1a1d26', fontFamily: mono, lineHeight: 1.1 }}>
              {sym}
            </div>
            {companyName && companyName !== sym && (
              <div style={{
                fontSize: 12, color: '#4a5068', fontWeight: 500,
                marginTop: 2, marginBottom: 4,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }} title={companyName}>
                {companyName}
              </div>
            )}
            <div style={{ fontSize: 22, fontWeight: 700, color: '#1a1d26', fontFamily: mono, lineHeight: 1, marginTop: 4 }}>
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
            {isAdvanced ? (
              <div style={{ fontSize: 11, color: '#8892a8', marginTop: 2 }}>
                R:R {risk.rr.toFixed(1)} · {risk.direction === 'long' ? '▲ Buy' : '▼ Sell'}
              </div>
            ) : (
              <div style={{ fontSize: 11, color: '#8892a8', marginTop: 2 }}>
                {risk.direction === 'long' ? '▲ Long bias' : '▼ Short bias'}
              </div>
            )}
          </div>
        </div>

        {/* Entry / SL / Target — prominent for quick mobile reading */}
        <div style={{
          display: 'flex',
          gap: 6,
          fontFamily: mono,
          marginBottom: 8,
          flexWrap: 'wrap',
        }}>
          <div style={{
            flex: '1 1 auto',
            padding: '8px 10px',
            borderRadius: 8,
            background: '#f5f6f8',
            border: '1px solid #e2e5eb',
            minWidth: 80,
          }}>
            <div style={{ fontSize: 10, color: '#8892a8', fontWeight: 600, marginBottom: 2 }}>Entry</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: '#1a1d26' }}>{risk.entry.toFixed(2)}</div>
          </div>
          <div style={{
            flex: '1 1 auto',
            padding: '8px 10px',
            borderRadius: 8,
            background: '#fef2f2',
            border: '1px solid #fecaca',
            minWidth: 80,
          }}>
            <div style={{ fontSize: 10, color: '#dc2626', fontWeight: 600, marginBottom: 2 }}>Stop Loss</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: '#dc2626' }}>{risk.sl.toFixed(2)}</div>
          </div>
          <div style={{
            flex: '1 1 auto',
            padding: '8px 10px',
            borderRadius: 8,
            background: '#f0fdf4',
            border: '1px solid #bbf7d0',
            minWidth: 80,
          }}>
            <div style={{ fontSize: 10, color: '#16a34a', fontWeight: 600, marginBottom: 2 }}>Target</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: '#16a34a' }}>{risk.target.toFixed(2)}</div>
          </div>
        </div>
        <div style={{ fontSize: 11, color: '#8892a8', marginBottom: 6 }}>
          {risk.direction === 'long' ? '▲ Buy side' : '▼ Sell side'}
          {isAdvanced && <span style={{ marginLeft: 8 }}>R:R {risk.rr.toFixed(1)}</span>}
        </div>

        {risk.action === 'WAIT' && (
          <div style={{ fontSize: 11, color: '#d97706', marginBottom: 6 }}>Pattern forming — wait for confirmation.</div>
        )}
        {risk.action === 'NO TRADE' && (
          <div style={{ fontSize: 11, color: '#8892a8', marginBottom: 6 }}>No clear signal right now.</div>
        )}

        {/* Badges row: context + confidence */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
          <span style={{
            fontSize: 13,
            fontWeight: 800,
            padding: '6px 12px',
            borderRadius: 6,
            background: ctx.bg,
            color: ctx.color,
            letterSpacing: 0.5,
            border: `1px solid ${ctx.color}22`,
          }}>
            {ctx.text}
          </span>
          <RiskRing score={confidence} level={risk.level} size="large" />
        </div>
        {ctx.desc && (
          <div style={{ fontSize: 11, color: '#8892a8', lineHeight: 1.4 }}>{ctx.desc}</div>
        )}
      </div>

      {/* Signals + patterns — compact in Simple, full digest in Advanced */}
      <div style={{
        padding: 10,
        borderRadius: 10,
        border: '1px solid #e2e5eb',
        background: '#fff',
        marginBottom: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: '#8892a8', fontWeight: 600 }}>
            {isAdvanced ? 'Signal evaluation' : 'Quick signals'}{' '}
            {identifiedCount}/{enabledList.length}
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
        {isAdvanced ? (
          <>
            <div style={{ fontSize: 11, color: '#4a5068', lineHeight: 1.5, marginBottom: 8 }}>
              ~{signalMeta.rulesApprox}+ rules across {signalMeta.categoryCount} pattern families;{' '}
              <strong>{(allPatterns || patterns).length}</strong> live hit(s) on the latest bar (before filters).
              Score blends signal clarity, noise, R:R, pattern reliability, and confluence.
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
          </>
        ) : (
          <div style={{ fontSize: 11, color: '#8892a8', lineHeight: 1.45 }}>
            Categories turned on in the menu: <strong>{enabledList.length}</strong>. Open Advanced for full rule
            counts, bid/ask, and extra panels — trade call stays the same.
          </div>
        )}
      </div>

      {beforeScoreDetails}
      {!isAdvanced && (
        <>
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
        </>
      )}
    </div>
  );
}

/** Score details toggle — used at the end of AdvancedView */
export function ScoreDetailsToggle({ risk }) {
  const [showDetails, setShowDetails] = useState(false);
  return (
    <>
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
    </>
  );
}
