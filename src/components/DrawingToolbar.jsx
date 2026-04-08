import { useState, useRef, useEffect } from 'react';

/* ── SVG Icons ──────────────────────────────────────────────────── */
const IconPencil = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
    <path d="m15 5 4 4"/>
  </svg>
);
const IconLine = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="4" y1="12" x2="20" y2="12"/>
    <circle cx="4" cy="12" r="1.5" fill="currentColor"/>
    <circle cx="20" cy="12" r="1.5" fill="currentColor"/>
  </svg>
);
const IconBox = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
  </svg>
);
const IconTrash = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
  </svg>
);
const IconX = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

const TOOLS = [
  { key: 'hline', label: 'Horizontal Line', Icon: IconLine },
  { key: 'box', label: 'Box', Icon: IconBox },
];

const btnBase = {
  minHeight: 32,
  minWidth: 32,
  padding: '0 8px',
  fontSize: 14,
  fontWeight: 600,
  borderRadius: 8,
  border: '1px solid',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
};

export default function DrawingToolbar({ active, onChange, onClear }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', handleClick);
    return () => document.removeEventListener('pointerdown', handleClick);
  }, [open]);

  useEffect(() => {
    if (active) setOpen(false);
  }, [active]);

  const hasDrawing = !!active;
  const ActiveIcon = active === 'hline' ? IconLine : active === 'box' ? IconBox : null;

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button
        type="button"
        title="Drawing tools"
        onClick={() => setOpen((v) => !v)}
        style={{
          ...btnBase,
          padding: '0 6px',
          borderColor: open || hasDrawing ? '#8b5cf6' : '#e2e5eb',
          background: open || hasDrawing ? '#f5f3ff' : '#fff',
          color: open || hasDrawing ? '#8b5cf6' : '#4a5068',
        }}
      >
        <IconPencil />
      </button>

      {active && (
        <button
          type="button"
          onClick={() => onChange(null)}
          title="Cancel drawing"
          style={{
            ...btnBase,
            padding: '0 8px',
            fontSize: 11,
            borderColor: '#8b5cf6',
            background: '#f5f3ff',
            color: '#8b5cf6',
          }}
        >
          {ActiveIcon && <ActiveIcon />}
          <IconX />
        </button>
      )}

      {open && (
        <div style={{
          position: 'absolute',
          top: '100%',
          right: 0,
          marginTop: 4,
          background: '#fff',
          border: '1px solid #e2e5eb',
          borderRadius: 10,
          boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          padding: 6,
          display: 'flex',
          gap: 4,
          zIndex: 50,
        }}>
          {TOOLS.map(({ key, label, Icon }) => {
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
                <Icon />
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
            }}
          >
            <IconTrash />
          </button>
        </div>
      )}
    </span>
  );
}
