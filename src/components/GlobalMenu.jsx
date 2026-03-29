import { useState, useRef, useEffect } from 'react';

const CATEGORIES = [
  { key: 'engulfing', label: 'Engulfing' },
  { key: 'piercing', label: 'Piercing' },
  { key: 'hammer', label: 'Hammer' },
  { key: 'reversal', label: 'Reversal' },
  { key: 'pullback', label: 'Pullback' },
  { key: 'liquidity', label: 'Liquidity' },
  { key: 'momentum', label: 'Momentum' },
  { key: 'indecision', label: 'Indecision' },
];

/**
 * @param {Object} props
 * @param {Set} props.activeFilters
 * @param {(filters: Set) => void} props.onFiltersChange
 * @param {{ label: string, onClick: () => void }} [props.navAction] — top menu action (e.g. "Index Scanner" or "Stock Scanner")
 */
export default function GlobalMenu({ activeFilters, onFiltersChange, navAction }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [open]);

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
          {navAction && (
            <>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  navAction.onClick();
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 10px',
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#1a1d26',
                  background: 'none',
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
                {navAction.label}
              </button>
              <div style={{ borderBottom: '1px solid #eef0f4', margin: '4px 0' }} />
            </>
          )}

          <div
            style={{
              padding: '6px 10px',
              fontSize: 11,
              fontWeight: 700,
              color: '#8892a8',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            Signal filters
            <span
              style={{
                fontSize: 10,
                background: filterCount === CATEGORIES.length ? '#e2e5eb' : '#2563eb',
                color: filterCount === CATEGORIES.length ? '#4a5068' : '#fff',
                borderRadius: 10,
                padding: '1px 6px',
                fontWeight: 700,
              }}
            >
              {filterCount}/{CATEGORIES.length}
            </span>
          </div>

          {CATEGORIES.map(({ key, label }) => (
            <label
              key={key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 10px',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 600,
                color: activeFilters.has(key) ? '#1a1d26' : '#8892a8',
                borderRadius: 4,
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              <input
                type="checkbox"
                checked={activeFilters.has(key)}
                onChange={() => toggleFilter(key)}
                style={{ accentColor: '#2563eb', margin: 0, width: 18, height: 18 }}
              />
              {label}
            </label>
          ))}

          <div
            style={{
              borderTop: '1px solid #eef0f4',
              marginTop: 6,
              paddingTop: 8,
              padding: '6px 10px 4px',
              display: 'flex',
              gap: 6,
            }}
          >
            <button
              type="button"
              onClick={() => onFiltersChange(new Set(CATEGORIES.map((c) => c.key)))}
              style={{
                flex: 1,
                fontSize: 12,
                fontWeight: 600,
                padding: '8px 0',
                border: '1px solid #e2e5eb',
                borderRadius: 6,
                background: '#fff',
                color: '#2563eb',
                cursor: 'pointer',
              }}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => onFiltersChange(new Set())}
              style={{
                flex: 1,
                fontSize: 12,
                fontWeight: 600,
                padding: '8px 0',
                border: '1px solid #e2e5eb',
                borderRadius: 6,
                background: '#fff',
                color: '#8892a8',
                cursor: 'pointer',
              }}
            >
              None
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
