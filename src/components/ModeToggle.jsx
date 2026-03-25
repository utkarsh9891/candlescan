const btn = (active) => ({
  flex: 1,
  minHeight: 44,
  fontSize: 14,
  fontWeight: 600,
  borderRadius: 10,
  border: active ? '2px solid #2563eb' : '1px solid #e2e5eb',
  background: active ? '#eff6ff' : '#fff',
  color: active ? '#2563eb' : '#4a5068',
  cursor: 'pointer',
});

export default function ModeToggle({ mode, onChange }) {
  const modes = [
    { id: 'simple', label: 'Simple' },
    { id: 'trader', label: 'Trader' },
    { id: 'scalp', label: 'Scalp' },
  ];
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
      {modes.map((m) => (
        <button
          key={m.id}
          type="button"
          style={btn(mode === m.id)}
          onClick={() => onChange(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
