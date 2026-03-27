export default function SearchBar({
  inputVal,
  setInputVal,
  onScan,
  loading,
  onOpenStockList,
  universeLabel,
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          alignItems: 'stretch',
        }}
      >
        <input
          type="text"
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && onScan()}
          placeholder="NSE symbol (e.g. RELIANCE)"
          style={{
            flex: '1 1 140px',
            minWidth: 0,
            minHeight: 44,
            padding: '0 14px',
            fontSize: 14,
            borderRadius: 10,
            border: '1px solid #e2e5eb',
            fontFamily: 'inherit',
            boxSizing: 'border-box',
          }}
        />
        {typeof onOpenStockList === 'function' ? (
          <button
            type="button"
            onClick={onOpenStockList}
            title={universeLabel ? `Open ${universeLabel} list` : 'Open stock list'}
            style={{
              minHeight: 44,
              padding: '0 14px',
              fontSize: 13,
              fontWeight: 700,
              borderRadius: 10,
              border: '1px solid #bfdbfe',
              background: '#eff6ff',
              color: '#1d4ed8',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              flexShrink: 0,
              maxWidth: 'min(220px, 46vw)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            {universeLabel || 'Stocks'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onScan}
          disabled={loading}
          style={{
            minHeight: 44,
            minWidth: 88,
            padding: '0 16px',
            fontSize: 15,
            fontWeight: 700,
            borderRadius: 10,
            border: 'none',
            background: loading ? '#a5b4fc' : '#2563eb',
            color: '#fff',
            cursor: loading ? 'wait' : 'pointer',
            flexShrink: 0,
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          {loading ? '…' : 'Scan'}
        </button>
      </div>
    </div>
  );
}
