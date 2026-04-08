import { useMemo, useState, useRef, useEffect } from 'react';
import { NSE_INDEX_OPTIONS } from '../config/nseIndices.js';

const mono = "'SF Mono', Menlo, monospace";

const IconChevron = ({ open }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
    style={{ transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}>
    <polyline points="6 9 12 15 18 9"/>
  </svg>
);

const IconRefresh = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
  </svg>
);

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
  onRefresh,
  isDynamic,
}) {
  const [q, setQ] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handle = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setDropdownOpen(false);
    };
    document.addEventListener('pointerdown', handle);
    return () => document.removeEventListener('pointerdown', handle);
  }, [dropdownOpen]);

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

  const hasCustom = nseIndexOptions.length > NSE_INDEX_OPTIONS.length;
  const customOptions = hasCustom ? nseIndexOptions.slice(NSE_INDEX_OPTIONS.length) : [];
  const selectedLabel = nseIndexOptions.find(o => o.id === selectedNseIndex)?.label || selectedNseIndex;

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
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: '#8892a8', fontWeight: 600 }}>Index</span>
                {isDynamic && onRefresh && (
                  <button type="button" onClick={onRefresh} title="Refresh list"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#2563eb', padding: 2, display: 'flex', alignItems: 'center' }}>
                    <IconRefresh />
                  </button>
                )}
              </div>
              {showIndexSelect ? (
                <div ref={dropdownRef} style={{ position: 'relative' }}>
                  {/* Custom dropdown trigger */}
                  <button
                    type="button"
                    onClick={() => setDropdownOpen(v => !v)}
                    style={{
                      width: '100%',
                      padding: '10px 36px 10px 12px',
                      borderRadius: 8,
                      border: '1px solid #e2e5eb',
                      fontSize: 13,
                      fontWeight: 700,
                      color: '#1a1d26',
                      background: '#fafbfc',
                      boxSizing: 'border-box',
                      cursor: 'pointer',
                      textAlign: 'left',
                      position: 'relative',
                    }}
                  >
                    {selectedLabel}
                    <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: '#8892a8' }}>
                      <IconChevron open={dropdownOpen} />
                    </span>
                  </button>

                  {/* Custom dropdown list */}
                  {dropdownOpen && (
                    <div style={{
                      position: 'absolute', top: '100%', left: 0, right: 0,
                      marginTop: 4, background: '#fff', border: '1px solid #e2e5eb',
                      borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                      maxHeight: 280, overflowY: 'auto', zIndex: 200,
                    }}>
                      {NSE_INDEX_OPTIONS.map(opt => (
                        <button key={opt.id} type="button"
                          onClick={() => { onNseIndexChange(opt.id); setDropdownOpen(false); }}
                          style={{
                            width: '100%', padding: '10px 14px', border: 'none', textAlign: 'left',
                            fontSize: 13, fontWeight: selectedNseIndex === opt.id ? 700 : 500,
                            background: selectedNseIndex === opt.id ? '#eff6ff' : '#fff',
                            color: selectedNseIndex === opt.id ? '#2563eb' : '#1a1d26',
                            cursor: 'pointer', borderBottom: '1px solid #f1f3f7',
                          }}
                        >
                          {opt.label}
                          {opt.dynamic && <span style={{ fontSize: 9, color: '#d97706', marginLeft: 6, fontWeight: 600 }}>LIVE</span>}
                        </button>
                      ))}
                      {customOptions.length > 0 && (
                        <>
                          <div style={{ padding: '6px 14px', fontSize: 10, fontWeight: 700, color: '#8892a8', textTransform: 'uppercase', letterSpacing: 0.5, background: '#f9fafb' }}>
                            Custom
                          </div>
                          {customOptions.map(opt => (
                            <button key={opt.id} type="button"
                              onClick={() => { onNseIndexChange(opt.id); setDropdownOpen(false); }}
                              style={{
                                width: '100%', padding: '10px 14px', border: 'none', textAlign: 'left',
                                fontSize: 13, fontWeight: selectedNseIndex === opt.id ? 700 : 500,
                                background: selectedNseIndex === opt.id ? '#eff6ff' : '#fff',
                                color: selectedNseIndex === opt.id ? '#2563eb' : '#1a1d26',
                                cursor: 'pointer', borderBottom: '1px solid #f1f3f7',
                              }}
                            >
                              {opt.id}
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
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
