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
  const toggle = (key) => {
    const next = new Set(active);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: '#8892a8', marginBottom: 6 }}>Signal filters</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {CATEGORIES.map(({ key, label }) => {
          const on = active.has(key);
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggle(key)}
              style={{
                minHeight: 30,
                padding: '0 10px',
                fontSize: 11,
                fontWeight: 600,
                borderRadius: 6,
                border: '1px solid',
                borderColor: on ? '#2563eb' : '#e2e5eb',
                background: on ? '#eff6ff' : '#fff',
                color: on ? '#2563eb' : '#8892a8',
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
