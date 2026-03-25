const pill = (active) => ({
  minHeight: 36,
  padding: '0 14px',
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 999,
  border: active ? 'none' : '1px solid #e2e5eb',
  background: active ? '#2563eb' : '#fff',
  color: active ? '#fff' : '#4a5068',
  cursor: 'pointer',
});

export default function TimeframePills({ mode, value, onChange }) {
  const simpleTfs = ['1m', '5m', '15m'];
  const allTfs = ['1m', '5m', '15m', '30m', '1h', '1d'];
  const list = mode === 'simple' ? simpleTfs : allTfs;
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        marginBottom: 12,
      }}
    >
      {list.map((tf) => (
        <button
          key={tf}
          type="button"
          style={pill(value === tf)}
          onClick={() => onChange(tf)}
        >
          {tf}
        </button>
      ))}
    </div>
  );
}
