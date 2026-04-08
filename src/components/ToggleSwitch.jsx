/**
 * Modern toggle switch component (replaces checkboxes).
 * Pure CSS — no library needed. Hidden checkbox remains focusable for accessibility.
 *
 * @param {object} props
 * @param {boolean} props.checked
 * @param {(checked: boolean) => void} props.onChange
 * @param {string} [props.label]
 * @param {boolean} [props.disabled]
 * @param {boolean} [props.compact] — smaller size for dense UIs (e.g. filter lists)
 * @param {string} [props.activeColor] — track color when on (default #2563eb)
 */
export default function ToggleSwitch({ checked, onChange, label, disabled = false, compact = false, activeColor = '#2563eb' }) {
  const w = compact ? 30 : 38;
  const h = compact ? 16 : 20;
  const knob = compact ? 12 : 16;
  const pad = 2;

  return (
    <label style={{
      display: 'inline-flex', alignItems: 'center', gap: compact ? 6 : 8,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      userSelect: 'none',
    }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => !disabled && onChange(e.target.checked)}
        disabled={disabled}
        style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
      />
      <span style={{
        position: 'relative', display: 'inline-block',
        width: w, height: h, borderRadius: h,
        background: checked ? activeColor : '#d1d5db',
        transition: 'background 0.2s',
        flexShrink: 0,
      }}>
        <span style={{
          position: 'absolute',
          top: pad, left: checked ? w - knob - pad : pad,
          width: knob, height: knob, borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          transition: 'left 0.2s',
        }} />
      </span>
      {label && (
        <span style={{
          fontSize: compact ? 11 : 13,
          fontWeight: 600,
          color: checked ? activeColor : '#4a5068',
        }}>
          {label}
        </span>
      )}
    </label>
  );
}
