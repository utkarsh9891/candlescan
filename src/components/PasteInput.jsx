import { useState, useCallback } from 'react';

const mono = "'SF Mono', Menlo, monospace";

const IconEye = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
  </svg>
);
const IconEyeOff = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
);

/**
 * Text input with paste + eye toggle buttons.
 * All password fields hidden by default with eye toggle to reveal.
 */
export default function PasteInput({ value, onChange, placeholder, type = 'text', useMono = false, style }) {
  const [showValue, setShowValue] = useState(false);
  const isPassword = type === 'password';

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) onChange(text.trim());
    } catch { /* clipboard denied — user can type manually */ }
  }, [onChange]);

  // Calculate right padding: paste button (52px) + eye button if password (30px)
  const paddingRight = isPassword ? 100 : 70;

  return (
    <div style={{ position: 'relative', marginBottom: 10, ...style }}>
      <input
        type={isPassword && !showValue ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        style={{
          width: '100%',
          padding: `10px ${paddingRight}px 10px 12px`,
          fontSize: 13,
          border: '1px solid #e2e5eb',
          borderRadius: 8,
          outline: 'none',
          boxSizing: 'border-box',
          fontFamily: useMono ? mono : 'inherit',
        }}
      />
      <div style={{
        position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
        display: 'flex', alignItems: 'center', gap: 2,
      }}>
        {isPassword && (
          <button
            type="button"
            onClick={() => setShowValue((v) => !v)}
            tabIndex={-1}
            style={{
              padding: 4, background: 'none', border: 'none', cursor: 'pointer',
              color: '#8892a8', display: 'flex', alignItems: 'center',
            }}
            aria-label={showValue ? 'Hide value' : 'Show value'}
          >
            {showValue ? <IconEyeOff /> : <IconEye />}
          </button>
        )}
        <button
          type="button"
          onClick={handlePaste}
          tabIndex={-1}
          style={{
            padding: '4px 10px',
            fontSize: 11,
            fontWeight: 600,
            color: '#2563eb',
            background: '#eff6ff',
            border: '1px solid #dbeafe',
            borderRadius: 5,
            cursor: 'pointer',
            lineHeight: 1,
          }}
        >
          Paste
        </button>
      </div>
    </div>
  );
}
