import { useMemo, useState } from 'react';
import { NSE_INDEX_OPTIONS } from '../config/nseIndices.js';

const mono = "'SF Mono', Menlo, monospace";

export default function IndexConstituentsSidebar({
  open,
  onClose,
  indexLabel,
  nseIndexOptions = [],
  selectedNseIndex,
  onNseIndexChange,
  symbols,
  companyMap = {},
  loading,
  error,
  onSelectSymbol,
}) {
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    if (!needle) return symbols;
    return symbols.filter((s) => {
      if (s.includes(needle)) return true;
      const name = (companyMap[s] || '').toUpperCase();
      return name.includes(needle);
    });
  }, [symbols, q, companyMap]);

  if (!open) return null;

  const showIndexSelect =
    nseIndexOptions.length > 0 && typeof onNseIndexChange === 'function' && selectedNseIndex != null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${indexLabel} constituents`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 500,
        background: 'rgba(26,29,38,0.45)',
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <button
        type="button"
        aria-label="Close list"
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
        }}
      />
      <aside
        style={{
          position: 'relative',
          width: 'min(100%, 400px)',
          maxWidth: '100%',
          height: '100%',
          background: '#f5f6f8',
          boxShadow: '-4px 0 24px rgba(0,0,0,0.15)',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 1,
        }}
      >
        <div
          style={{
            padding: '14px 16px',
            borderBottom: '1px solid #e2e5eb',
            background: '#fff',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: '#8892a8', fontWeight: 600, marginBottom: 4 }}>
                Index
              </div>
              {showIndexSelect ? (
                <select
                  value={selectedNseIndex}
                  onChange={(e) => onNseIndexChange(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid #e2e5eb',
                    fontSize: 13,
                    fontWeight: 700,
                    color: '#1a1d26',
                    background: '#fafbfc',
                    boxSizing: 'border-box',
                    cursor: 'pointer',
                  }}
                >
                  {NSE_INDEX_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                  {nseIndexOptions.length > NSE_INDEX_OPTIONS.length && (
                    <optgroup label="Custom">
                      {nseIndexOptions.slice(NSE_INDEX_OPTIONS.length).map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.id}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              ) : (
                <div style={{ fontSize: 16, fontWeight: 800, color: '#1a1d26' }}>{indexLabel}</div>
              )}
              <div style={{ fontSize: 11, color: '#8892a8', marginTop: 6 }}>
                {loading ? 'Loading…' : `${symbols.length} equities (EQ)`}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                border: '1px solid #e2e5eb',
                background: '#fff',
                fontSize: 20,
                lineHeight: 1,
                cursor: 'pointer',
                color: '#4a5068',
                flexShrink: 0,
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              ×
            </button>
          </div>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search symbol or company name…"
            style={{
              width: '100%',
              marginTop: 12,
              padding: '10px 12px',
              borderRadius: 8,
              border: '1px solid #e2e5eb',
              fontSize: 14,
              fontFamily: 'inherit',
              boxSizing: 'border-box',
            }}
          />
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '8px 10px 24px' }}>
          {error ? (
            <div
              style={{
                padding: 12,
                borderRadius: 10,
                background: '#fef2f2',
                border: '1px solid #fecaca',
                color: '#991b1b',
                fontSize: 13,
              }}
            >
              {error}
            </div>
          ) : null}
          {loading && !symbols.length ? (
            <div style={{ padding: 32, textAlign: 'center', color: '#8892a8', fontSize: 14 }}>
              Loading constituents from NSE…
            </div>
          ) : null}
          {!loading &&
            !error &&
            filtered.map((sym) => (
              <button
                key={sym}
                type="button"
                onClick={() => {
                  onSelectSymbol(sym);
                  onClose();
                }}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 14px',
                  marginBottom: 4,
                  borderRadius: 8,
                  border: '1px solid #e2e5eb',
                  background: '#fff',
                  cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 700, fontFamily: mono, color: '#2563eb', minWidth: 70 }}>
                  {sym}
                </span>
                {companyMap[sym] && (
                  <span style={{ fontSize: 11, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {companyMap[sym]}
                  </span>
                )}
              </button>
            ))}
        </div>
      </aside>
    </div>
  );
}
