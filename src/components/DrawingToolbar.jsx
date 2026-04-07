import { useState, useRef, useEffect } from 'react';

const TOOLS = [
  { key: 'hline', label: 'Line', icon: '━' },
  { key: 'box', label: 'Box', icon: '▭' },
];

const btnBase = {
  minHeight: 28,
  minWidth: 32,
  padding: '0 8px',
  fontSize: 14,
  fontWeight: 600,
  borderRadius: 6,
  border: '1px solid',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  lineHeight: '28px',
};

export default function DrawingToolbar({ active, onChange, onClear }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close popover on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', handleClick);
    return () => document.removeEventListener('pointerdown', handleClick);
  }, [open]);

  // Close popover when drawing starts
  useEffect(() => {
    if (active) setOpen(false);
  }, [active]);

  const hasDrawing = !!active;

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {/* Toggle icon — pencil/draw */}
      <button
        type="button"
        title="Drawing tools"
        onClick={() => setOpen((v) => !v)}
        style={{
          ...btnBase,
          minWidth: 28,
          padding: '0 6px',
          fontSize: 15,
          borderColor: open || hasDrawing ? '#8b5cf6' : '#e2e5eb',
          background: open || hasDrawing ? '#f5f3ff' : '#fff',
          color: open || hasDrawing ? '#8b5cf6' : '#4a5068',
        }}
      >
        ✏
      </button>

      {/* Active indicator — show which tool is active */}
      {active && (
        <button
          type="button"
          onClick={() => onChange(null)}
          title="Cancel drawing"
          style={{
            ...btnBase,
            padding: '0 6px',
            fontSize: 11,
            borderColor: '#8b5cf6',
            background: '#f5f3ff',
            color: '#8b5cf6',
            minWidth: 'auto',
          }}
        >
          {active === 'hline' ? '━' : '▭'} ✕
        </button>
      )}

      {/* Popover */}
      {open && (
        <div style={{
          position: 'absolute',
          top: '100%',
          right: 0,
          marginTop: 4,
          background: '#fff',
          border: '1px solid #e2e5eb',
          borderRadius: 8,
          boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          padding: 6,
          display: 'flex',
          gap: 4,
          zIndex: 50,
          whiteSpace: 'nowrap',
        }}>
          {TOOLS.map(({ key, label, icon }) => {
            const on = active === key;
            return (
              <button
                key={key}
                type="button"
                title={label}
                onClick={() => { onChange(on ? null : key); }}
                style={{
                  ...btnBase,
                  borderColor: on ? '#8b5cf6' : '#e2e5eb',
                  background: on ? '#f5f3ff' : '#fff',
                  color: on ? '#8b5cf6' : '#4a5068',
                }}
              >
                {icon}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => { onClear(); setOpen(false); }}
            title="Clear all drawings"
            style={{
              ...btnBase,
              borderColor: '#fecaca',
              background: '#fff',
              color: '#dc2626',
              fontSize: 12,
            }}
          >
            Clear
          </button>
        </div>
      )}
    </span>
  );
}
