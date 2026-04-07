import { useState, useRef, useEffect } from 'react';
import CustomIndexInput from './CustomIndexInput.jsx';
import { SCALP_VARIANTS } from '../engine/scalp-variants/registry.js';

const INTRADAY_CATEGORIES = [
  { key: 'engulfing', label: 'Engulfing' },
  { key: 'piercing', label: 'Piercing' },
  { key: 'hammer', label: 'Hammer' },
  { key: 'reversal', label: 'Reversal' },
  { key: 'pullback', label: 'Pullback' },
  { key: 'liquidity', label: 'Liquidity' },
  { key: 'momentum', label: 'Momentum' },
  { key: 'indecision', label: 'Indecision' },
];

const SCALP_CATEGORIES_UI = [
  { key: 'vwap', label: 'VWAP' },
  { key: 'orb', label: 'ORB' },
  { key: 'micro-momentum', label: 'Momentum' },
  { key: 'ema-cross', label: 'EMA Cross' },
  { key: 'volume-climax', label: 'Vol Climax' },
  { key: 'prev-day', label: 'Prev Day' },
  { key: 'micro-double', label: 'Double B/T' },
];

const CLASSIC_CATEGORIES_UI = [
  { key: 'ma-cross', label: 'MA Cross' },
  { key: 'support-resistance', label: 'Support/Resist' },
  { key: 'channel', label: 'Channel' },
  { key: 'volume-surge', label: 'Vol Surge' },
  { key: 'swing-structure', label: 'Swing Struct' },
  { key: 'daily-engulfing', label: 'Engulfing' },
  { key: 'gap', label: 'Gap' },
];

/**
 * @param {Object} props
 * @param {Set} props.activeFilters
 * @param {(filters: Set) => void} props.onFiltersChange
 * @param {{ label: string, onClick: () => void }} [props.navAction] — top menu action (e.g. "Index Scanner" or "Stock Scanner")
 */
export default function GlobalMenu({ activeFilters, onFiltersChange, navAction, simulationAction, paperTradingAction, settingsAction, customIndices, onAddCustomIndex, onRemoveCustomIndex, engineVersion, onEngineVersionChange, scalpVariant, onScalpVariantChange }) {
  const [open, setOpen] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [open]);

  const CATEGORIES = engineVersion === 'scalp' ? SCALP_CATEGORIES_UI : engineVersion === 'v1' ? CLASSIC_CATEGORIES_UI : INTRADAY_CATEGORIES;

  const toggleFilter = (key) => {
    const next = new Set(activeFilters);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onFiltersChange(next);
  };

  const filterCount = activeFilters.size;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: 40,
          height: 40,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 18,
          borderRadius: 8,
          border: '1px solid #e2e5eb',
          background: open ? '#eff6ff' : '#fff',
          color: open ? '#2563eb' : '#4a5068',
          cursor: 'pointer',
          flexShrink: 0,
          WebkitTapHighlightColor: 'transparent',
        }}
        aria-label="Signal filters"
        aria-expanded={open}
      >
        ☰
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 44,
            right: 0,
            zIndex: 250,
            width: 'min(320px, calc(100vw - 24px))',
            background: '#fff',
            border: '1px solid #e2e5eb',
            borderRadius: 10,
            padding: 8,
            maxHeight: 'min(72vh, 540px)',
            overflowY: 'auto',
            boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
            boxSizing: 'border-box',
          }}
        >
          {/* Navigation */}
          {navAction && (
            <>
              <button type="button" onClick={() => { setOpen(false); navAction.onClick(); }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 10px', fontSize: 13, fontWeight: 600, color: '#1a1d26', background: 'none', border: 'none', borderRadius: 6, cursor: 'pointer', WebkitTapHighlightColor: 'transparent' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round">
                  <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
                {navAction.label}
              </button>
              <div style={{ borderBottom: '1px solid #eef0f4', margin: '4px 0' }} />
            </>
          )}
          {simulationAction && (
            <>
              <button type="button" onClick={() => { setOpen(false); simulationAction.onClick(); }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 10px', fontSize: 13, fontWeight: 600, color: '#1a1d26', background: 'none', border: 'none', borderRadius: 6, cursor: 'pointer', WebkitTapHighlightColor: 'transparent' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                </svg>
                {simulationAction.label}
              </button>
              <div style={{ borderBottom: '1px solid #eef0f4', margin: '4px 0' }} />
            </>
          )}

          {paperTradingAction && (
            <>
              <button type="button" onClick={() => { setOpen(false); paperTradingAction.onClick(); }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 10px', fontSize: 13, fontWeight: 600, color: '#1a1d26', background: 'none', border: 'none', borderRadius: 6, cursor: 'pointer', WebkitTapHighlightColor: 'transparent' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="12" y1="18" x2="12" y2="12" />
                  <line x1="9" y1="15" x2="15" y2="15" />
                </svg>
                {paperTradingAction.label}
              </button>
              <div style={{ borderBottom: '1px solid #eef0f4', margin: '4px 0' }} />
            </>
          )}

          {/* Settings */}
          {settingsAction && (
            <>
              <button type="button" onClick={() => { setOpen(false); settingsAction.onClick(); }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 10px', fontSize: 13, fontWeight: 600, color: '#1a1d26', background: 'none', border: 'none', borderRadius: 6, cursor: 'pointer', WebkitTapHighlightColor: 'transparent' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8892a8" strokeWidth="2" strokeLinecap="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                Settings
              </button>
              <div style={{ borderBottom: '1px solid #eef0f4', margin: '4px 0' }} />
            </>
          )}

          {/* 1. Engine */}
          {onEngineVersionChange && (
            <>
              <div style={{ padding: '6px 10px', fontSize: 11, fontWeight: 700, color: '#8892a8', textTransform: 'uppercase', letterSpacing: 0.5 }}>Engine</div>
              <div style={{ display: 'flex', gap: 4, padding: '4px 10px 8px' }}>
                {[
                  { key: 'scalp', label: 'Scalp', color: '#d97706' },
                  { key: 'v2', label: 'Intraday', color: '#2563eb' },
                  { key: 'v1', label: 'Classic', color: '#16a34a' },
                ].map((v) => (
                  <button key={v.key} type="button" onClick={() => onEngineVersionChange(v.key)}
                    style={{ flex: 1, fontSize: 11, fontWeight: 600, padding: '8px 0', border: engineVersion === v.key ? 'none' : '1px solid #e2e5eb', borderRadius: 6, cursor: 'pointer', background: engineVersion === v.key ? v.color : '#fff', color: engineVersion === v.key ? '#fff' : '#4a5068' }}>
                    {v.label}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* 1b. Scalp variant selector */}
          {engineVersion === 'scalp' && onScalpVariantChange && (
            <>
              <div style={{ padding: '4px 10px 2px', fontSize: 10, fontWeight: 700, color: '#8892a8', textTransform: 'uppercase', letterSpacing: 0.5 }}>Scalp Variant</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, padding: '3px 10px 8px' }}>
                {SCALP_VARIANTS.map((v) => (
                  <button key={v.key} type="button" onClick={() => onScalpVariantChange(v.key)}
                    title={v.description}
                    style={{ fontSize: 10, fontWeight: 600, padding: '5px 8px', border: scalpVariant === v.key ? 'none' : '1px solid #e2e5eb', borderRadius: 5, cursor: 'pointer', background: scalpVariant === v.key ? v.color : '#fff', color: scalpVariant === v.key ? '#fff' : '#4a5068', whiteSpace: 'nowrap' }}>
                    {v.label}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* 2. Signal filters (collapsible) */}
          <div style={{ borderTop: '1px solid #eef0f4', marginTop: 2 }} />
          <button type="button" onClick={() => setFiltersExpanded(v => !v)}
            style={{ width: '100%', padding: '6px 10px', fontSize: 11, fontWeight: 700, color: '#8892a8', textTransform: 'uppercase', letterSpacing: 0.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'none', border: 'none', cursor: 'pointer', WebkitTapHighlightColor: 'transparent' }}>
            <span>{filtersExpanded ? '▾' : '▸'} Signal filters</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {!filtersExpanded && (
                <>
                  <span onClick={(e) => { e.stopPropagation(); onFiltersChange(new Set(CATEGORIES.map(c => c.key))); }} style={{ fontSize: 10, color: '#2563eb', cursor: 'pointer' }}>All</span>
                  <span onClick={(e) => { e.stopPropagation(); onFiltersChange(new Set()); }} style={{ fontSize: 10, color: '#8892a8', cursor: 'pointer' }}>None</span>
                </>
              )}
              <span style={{ fontSize: 10, background: filterCount === CATEGORIES.length ? '#e2e5eb' : '#2563eb', color: filterCount === CATEGORIES.length ? '#4a5068' : '#fff', borderRadius: 10, padding: '1px 6px', fontWeight: 700 }}>
                {filterCount}/{CATEGORIES.length}
              </span>
            </span>
          </button>
          {filtersExpanded && (
            <>
              {CATEGORIES.map(({ key, label }) => (
                <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: activeFilters.has(key) ? '#1a1d26' : '#8892a8', borderRadius: 4, WebkitTapHighlightColor: 'transparent' }}>
                  <input type="checkbox" checked={activeFilters.has(key)} onChange={() => toggleFilter(key)} style={{ accentColor: '#2563eb', margin: 0, width: 16, height: 16 }} />
                  {label}
                </label>
              ))}
              <div style={{ padding: '4px 10px 4px', display: 'flex', gap: 6 }}>
                <button type="button" onClick={() => onFiltersChange(new Set(CATEGORIES.map(c => c.key)))} style={{ flex: 1, fontSize: 11, fontWeight: 600, padding: '6px 0', border: '1px solid #e2e5eb', borderRadius: 6, background: '#fff', color: '#2563eb', cursor: 'pointer' }}>All</button>
                <button type="button" onClick={() => onFiltersChange(new Set())} style={{ flex: 1, fontSize: 11, fontWeight: 600, padding: '6px 0', border: '1px solid #e2e5eb', borderRadius: 6, background: '#fff', color: '#8892a8', cursor: 'pointer' }}>None</button>
              </div>
            </>
          )}

          {/* 3. Custom indices */}
          {onAddCustomIndex && (
            <>
              <div style={{ borderTop: '1px solid #eef0f4', marginTop: 6 }} />
              <div style={{ padding: '6px 10px', fontSize: 11, fontWeight: 700, color: '#8892a8', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 }}>Custom Indices</div>
              {customIndices?.length > 0 ? (
                customIndices.map(ci => (
                  <div key={ci.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px' }}>
                    <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: '#1a1d26' }}>{ci.id}</span>
                    <button type="button" onClick={() => onRemoveCustomIndex(ci.id)} title={`Remove ${ci.id}`}
                      style={{ width: 22, height: 22, borderRadius: 4, border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', fontSize: 14, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, padding: 0 }}>−</button>
                  </div>
                ))
              ) : (
                <div style={{ padding: '4px 10px', fontSize: 11, color: '#8892a8' }}>None added yet</div>
              )}
              <div style={{ padding: '4px 10px 6px' }}>
                <CustomIndexInput onAdd={(id) => { onAddCustomIndex(id); }} />
              </div>
            </>
          )}

          {/* 4. Version + update */}
          <div style={{ borderTop: '1px solid #eef0f4', marginTop: 6, padding: '6px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 10, color: '#b0b8c8' }}>
              {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'v?'} (pre-release)
            </span>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event('candlescan:check-update'))}
              style={{
                fontSize: 10, fontWeight: 600, color: '#2563eb',
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              }}
            >
              Check for updates
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
