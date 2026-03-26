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

export default function SignalFilters({ active, onChange }) {
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

  const toggle = (key) => {
    const next = new Set(active);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };

  const count = active.size;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          minHeight: 30,
          padding: '0 10px',
          fontSize: 11,
          fontWeight: 600,
          borderRadius: 6,
          border: '1px solid #e2e5eb',
          background: open ? '#eff6ff' : '#fff',
          color: open ? '#2563eb' : '#4a5068',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <span style={{ fontSize: 13 }}>⚙</span>
        Signals
        <span
          style={{
            fontSize: 10,
            background: count === CATEGORIES.length ? '#e2e5eb' : '#2563eb',
            color: count === CATEGORIES.length ? '#4a5068' : '#fff',
            borderRadius: 10,
            padding: '1px 5px',
            fontWeight: 700,
            marginLeft: 2,
          }}
        >
          {count}/{CATEGORIES.length}
        </span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 34,
            left: 0,
            zIndex: 100,
            background: '#fff',
            border: '1px solid #e2e5eb',
            borderRadius: 8,
            padding: 8,
            minWidth: 170,
            boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
          }}
        >
          {CATEGORIES.map(({ key, label }) => {
            const on = active.has(key);
            return (
              <label
                key={key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '5px 4px',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  color: on ? '#1a1d26' : '#8892a8',
                  borderRadius: 4,
                }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(key)}
                  style={{ accentColor: '#2563eb', margin: 0 }}
                />
                {label}
              </label>
            );
          })}
          <div style={{ borderTop: '1px solid #eef0f4', marginTop: 6, paddingTop: 6, display: 'flex', gap: 6 }}>
            <button
              type="button"
              onClick={() => onChange(new Set(CATEGORIES.map((c) => c.key)))}
              style={{
                flex: 1,
                fontSize: 10,
                fontWeight: 600,
                padding: '4px 0',
                border: '1px solid #e2e5eb',
                borderRadius: 4,
                background: '#fff',
                color: '#2563eb',
                cursor: 'pointer',
              }}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => onChange(new Set())}
              style={{
                flex: 1,
                fontSize: 10,
                fontWeight: 600,
                padding: '4px 0',
                border: '1px solid #e2e5eb',
                borderRadius: 4,
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
