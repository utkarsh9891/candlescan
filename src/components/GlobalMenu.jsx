import { useState, useRef, useEffect } from 'react';
import CustomIndexInput from './CustomIndexInput.jsx';
import ToggleSwitch from './ToggleSwitch.jsx';

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
 * Configuration menu (no longer navigation — bottom tab bar handles nav).
 * Controls: engine selection, signal category filters, custom indices.
 */
export default function GlobalMenu({
  activeFilters, onFiltersChange,
  customIndices, onAddCustomIndex, onRemoveCustomIndex,
  engineVersion, onEngineVersionChange,
}) {
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
        aria-label="Configuration"
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
                <div key={key} style={{ padding: '5px 10px' }}>
                  <ToggleSwitch checked={activeFilters.has(key)} onChange={() => toggleFilter(key)} label={label} compact />
                </div>
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

        </div>
      )}
    </div>
  );
}
