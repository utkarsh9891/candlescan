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

export default function GlobalMenu({ activeFilters, onFiltersChange }) {
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
          width: 36,
          height: 36,
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
        }}
        aria-label="Settings menu"
      >
        ☰
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 40,
            right: 0,
            zIndex: 200,
            background: '#fff',
            border: '1px solid #e2e5eb',
            borderRadius: 10,
            padding: 8,
            minWidth: 200,
            boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
          }}
        >
          {/* Signal filters header */}
          <div style={{ padding: '6px 10px', fontSize: 11, fontWeight: 700, color: '#8892a8', textTransform: 'uppercase', letterSpacing: 0.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            Signal Filters
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
                padding: '5px 10px',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 600,
                color: activeFilters.has(key) ? '#1a1d26' : '#8892a8',
                borderRadius: 4,
              }}
            >
              <input
                type="checkbox"
                checked={activeFilters.has(key)}
                onChange={() => toggleFilter(key)}
                style={{ accentColor: '#2563eb', margin: 0 }}
              />
              {label}
            </label>
          ))}

          <div style={{ borderTop: '1px solid #eef0f4', marginTop: 6, paddingTop: 6, padding: '6px 10px 4px', display: 'flex', gap: 6 }}>
            <button
              type="button"
              onClick={() => onFiltersChange(new Set(CATEGORIES.map((c) => c.key)))}
              style={{
                flex: 1, fontSize: 10, fontWeight: 600, padding: '4px 0',
                border: '1px solid #e2e5eb', borderRadius: 4, background: '#fff', color: '#2563eb', cursor: 'pointer',
              }}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => onFiltersChange(new Set())}
              style={{
                flex: 1, fontSize: 10, fontWeight: 600, padding: '4px 0',
                border: '1px solid #e2e5eb', borderRadius: 4, background: '#fff', color: '#8892a8', cursor: 'pointer',
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
