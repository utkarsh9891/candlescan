import { useCallback } from 'react';

const mono = "'SF Mono', Menlo, monospace";

/**
 * Text input with a paste button. Reads from clipboard on tap.
 *
 * @param {object} props
 * @param {string} props.value
 * @param {(v: string) => void} props.onChange
 * @param {string} [props.placeholder]
 * @param {string} [props.type] — 'text' | 'password'
 * @param {boolean} [props.useMono] — use monospace font
 * @param {object} [props.style] — extra styles merged onto the wrapper
 */
export default function PasteInput({ value, onChange, placeholder, type = 'text', useMono = false, style }) {
  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) onChange(text.trim());
    } catch {
      // Clipboard API denied — fall back silently (user can type/paste manually)
    }
  }, [onChange]);

  return (
    <div style={{ position: 'relative', marginBottom: 10, ...style }}>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        style={{
          width: '100%',
          padding: '10px 70px 10px 12px',
          fontSize: 13,
          border: '1px solid #e2e5eb',
          borderRadius: 8,
          outline: 'none',
          boxSizing: 'border-box',
          fontFamily: useMono ? mono : 'inherit',
        }}
      />
      <button
        type="button"
        onClick={handlePaste}
        tabIndex={-1}
        style={{
          position: 'absolute',
          right: 6,
          top: '50%',
          transform: 'translateY(-50%)',
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
  );
}
