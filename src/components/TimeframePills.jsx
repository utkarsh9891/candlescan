const pill = (active) => ({
  minHeight: 32,
  padding: '0 10px',
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 999,
  border: active ? 'none' : '1px solid #e2e5eb',
  background: active ? '#2563eb' : '#fff',
  color: active ? '#fff' : '#4a5068',
  cursor: 'pointer',
});

/** Default timeframes (Yahoo Finance / Zerodha). */
const DEFAULT_TFS = ['1m', '5m', '15m', '30m', '1h', '1d'];

/** Timeframes supported per data source. */
export const SOURCE_TIMEFRAMES = {
  yahoo: ['1m', '5m', '15m', '30m', '1h', '1d'],
  zerodha: ['1m', '5m', '15m', '30m', '1h', '1d'],
  dhan: ['1m', '5m', '15m', '25m', '1h', '1d'],
};

export default function TimeframePills({ value, onChange, available }) {
  const tfs = available || DEFAULT_TFS;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
      {tfs.map((tf) => (
        <button key={tf} type="button" style={pill(value === tf)} onClick={() => onChange(tf)}>
          {tf}
        </button>
      ))}
    </div>
  );
}
