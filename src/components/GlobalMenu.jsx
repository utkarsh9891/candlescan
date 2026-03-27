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

export default function GlobalMenu({ mode, onModeChange, activeFilters, onFiltersChange }) {
  const [open, setOpen] = useState(false);
  const [signalOpen, setSignalOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
        setSignalOpen(false);
      }
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
        onClick={() => { setOpen((o) => !o); if (open) setSignalOpen(false); }}
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
            padding: 6,
            minWidth: 200,
            boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
          }}
        >
          {/* Mode toggle */}
          <div style={{ padding: '8px 10px', fontSize: 11, fontWeight: 700, color: '#8892a8', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            View Mode
          </div>
          {['simple', 'advanced'].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onModeChange(m)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '8px 10px',
                fontSize: 13,
                fontWeight: 600,
                border: 'none',
                borderRadius: 6,
                background: mode === m ? '#eff6ff' : 'transparent',
                color: mode === m ? '#2563eb' : '#1a1d26',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ width: 16, textAlign: 'center' }}>{mode === m ? '●' : '○'}</span>
              {m === 'simple' ? 'Simple' : 'Advanced'}
              <span style={{ fontSize: 10, color: '#8892a8', marginLeft: 'auto' }}>
                {m === 'simple' ? 'Quick scan' : 'Full analysis'}
              </span>
            </button>
          ))}

          <div style={{ borderTop: '1px solid #eef0f4', margin: '6px 0' }} />

          {/* Signal filters submenu */}
          <button
            type="button"
            onClick={() => setSignalOpen((o) => !o)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '8px 10px',
              fontSize: 13,
              fontWeight: 600,
              border: 'none',
              borderRadius: 6,
              background: signalOpen ? '#eff6ff' : 'transparent',
              color: signalOpen ? '#2563eb' : '#1a1d26',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{ width: 16, textAlign: 'center' }}>⚙</span>
            Signal Filters
            <span
              style={{
                fontSize: 10,
                background: filterCount === CATEGORIES.length ? '#e2e5eb' : '#2563eb',
                color: filterCount === CATEGORIES.length ? '#4a5068' : '#fff',
                borderRadius: 10,
                padding: '1px 5px',
                fontWeight: 700,
                marginLeft: 'auto',
              }}
            >
              {filterCount}/{CATEGORIES.length}
            </span>
            <span style={{ fontSize: 10, color: '#8892a8' }}>{signalOpen ? '▲' : '▼'}</span>
          </button>

          {signalOpen && (
            <div style={{ padding: '4px 10px 8px 34px' }}>
              {CATEGORIES.map(({ key, label }) => (
                <label
                  key={key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 0',
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: 600,
                    color: activeFilters.has(key) ? '#1a1d26' : '#8892a8',
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
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
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
      )}
    </div>
  );
}
