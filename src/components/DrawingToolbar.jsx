const TOOLS = [
  { key: 'hline', label: 'H-Line', icon: '─' },
  { key: 'box', label: 'Box', icon: '▭' },
];

const btnBase = {
  minHeight: 30,
  padding: '0 10px',
  fontSize: 11,
  fontWeight: 600,
  borderRadius: 6,
  border: '1px solid',
  cursor: 'pointer',
};

export default function DrawingToolbar({ active, onChange, onClear }) {
  return (
    <>
      <span style={{ fontSize: 12, color: '#8892a8', marginRight: 2 }}>Draw:</span>
      {TOOLS.map(({ key, label, icon }) => {
        const on = active === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(on ? null : key)}
            style={{
              ...btnBase,
              borderColor: on ? '#8b5cf6' : '#e2e5eb',
              background: on ? '#f5f3ff' : '#fff',
              color: on ? '#8b5cf6' : '#4a5068',
            }}
          >
            {icon} {label}
          </button>
        );
      })}
      <button
        type="button"
        onClick={onClear}
        style={{
          ...btnBase,
          borderColor: '#e2e5eb',
          background: '#fff',
          color: '#dc2626',
        }}
      >
        Clear
      </button>
    </>
  );
}
