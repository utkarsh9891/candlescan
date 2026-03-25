export default function SearchBar({
  inputVal,
  setInputVal,
  onScan,
  loading,
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && onScan()}
          placeholder="NSE symbol (e.g. RELIANCE)"
          style={{
            flex: 1,
            minHeight: 44,
            padding: '0 14px',
            fontSize: 14,
            borderRadius: 10,
            border: '1px solid #e2e5eb',
            fontFamily: 'inherit',
          }}
        />
        <button
          type="button"
          onClick={onScan}
          disabled={loading}
          style={{
            minHeight: 44,
            minWidth: 96,
            padding: '0 18px',
            fontSize: 15,
            fontWeight: 700,
            borderRadius: 10,
            border: 'none',
            background: loading ? '#a5b4fc' : '#2563eb',
            color: '#fff',
            cursor: loading ? 'wait' : 'pointer',
          }}
        >
          {loading ? '…' : 'Scan'}
        </button>
      </div>
    </div>
  );
}
