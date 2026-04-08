import { useState, useRef, useEffect, useMemo, useCallback } from 'react';

const mono = "'SF Mono', Menlo, monospace";

export default function SearchBar({
  inputVal,
  setInputVal,
  onScan,
  loading,
  onOpenStockList,
  universeLabel,
  symbols = [],
  companyMap = {},
}) {
  const [focused, setFocused] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const wrapRef = useRef(null);
  // Guard: when a dropdown item is selected, block all clicks on underlying
  // elements for a short window to prevent touch event pass-through.
  const clickGuardRef = useRef(false);

  // Fuzzy match: search both symbol and company name
  const suggestions = useMemo(() => {
    const q = inputVal.trim().toUpperCase();
    if (!q || q.length < 2 || !symbols.length) return [];

    const scored = [];
    for (const sym of symbols) {
      const name = (companyMap[sym] || '').toUpperCase();
      const symMatch = sym.includes(q);
      const nameMatch = name.includes(q);
      if (!symMatch && !nameMatch) continue;
      const score = sym.startsWith(q) ? 0 : symMatch ? 1 : 2;
      scored.push({ sym, name: companyMap[sym] || '', score });
    }
    scored.sort((a, b) => a.score - b.score || a.sym.localeCompare(b.sym));
    return scored.slice(0, 8);
  }, [inputVal, symbols, companyMap]);

  const showDropdown = focused && suggestions.length > 0;

  // Close on outside click — but respect the click guard
  useEffect(() => {
    if (!showDropdown) return;
    const handle = (e) => {
      if (clickGuardRef.current) return;
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setFocused(false);
    };
    document.addEventListener('pointerdown', handle);
    return () => document.removeEventListener('pointerdown', handle);
  }, [showDropdown]);

  // Block clicks on underlying elements after a dropdown selection.
  // This is the ONLY reliable way to prevent touch click-through:
  // capture ALL click events at the document level during the guard window.
  useEffect(() => {
    if (!clickGuardRef.current) return;
    const blocker = (e) => {
      // Allow clicks inside the search wrapper
      if (wrapRef.current && wrapRef.current.contains(e.target)) return;
      e.stopPropagation();
      e.preventDefault();
    };
    // Capture phase so we intercept before any handler or tap highlight fires
    const events = ['click', 'pointerup', 'pointerdown', 'touchend', 'touchstart', 'mousedown', 'mouseup'];
    events.forEach(evt => document.addEventListener(evt, blocker, true));
    const id = setTimeout(() => {
      clickGuardRef.current = false;
      events.forEach(evt => document.removeEventListener(evt, blocker, true));
    }, 500);
    return () => {
      clearTimeout(id);
      events.forEach(evt => document.removeEventListener(evt, blocker, true));
    };
  });

  // Reset selection when suggestions change
  useEffect(() => { setSelectedIdx(-1); }, [suggestions]);

  // Close dropdown when a scan starts (e.g. from sidebar stock pick)
  useEffect(() => { if (loading) setFocused(false); }, [loading]);

  const selectSymbol = useCallback((sym) => {
    // Activate click guard BEFORE closing dropdown
    clickGuardRef.current = true;
    setInputVal(sym);
    setFocused(false);
    setTimeout(() => onScan(sym), 0);
  }, [setInputVal, onScan]);

  const handleKeyDown = (e) => {
    if (!showDropdown) {
      if (e.key === 'Enter') onScan();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIdx >= 0 && suggestions[selectedIdx]) {
        selectSymbol(suggestions[selectedIdx].sym);
      } else {
        onScan();
        setFocused(false);
      }
    } else if (e.key === 'Escape') {
      setFocused(false);
    }
  };

  return (
    <div style={{ marginBottom: 10 }} ref={wrapRef}>
      {/* Search + Scan row */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', position: 'relative' }}>
        <div style={{ flex: '1 1 140px', minWidth: 0, position: 'relative' }}>
          <input
            type="text"
            value={inputVal}
            onChange={(e) => { setInputVal(e.target.value.toUpperCase()); setFocused(true); }}
            onFocus={() => setFocused(true)}
            onKeyDown={handleKeyDown}
            placeholder="Search symbol or company name"
            autoComplete="off"
            style={{
              width: '100%',
              minHeight: 44,
              padding: '0 14px',
              fontSize: 14,
              borderRadius: showDropdown ? '10px 10px 0 0' : 10,
              border: '1px solid #e2e5eb',
              fontFamily: 'inherit',
              boxSizing: 'border-box',
            }}
          />

          {/* Autocomplete dropdown */}
          {showDropdown && (
            <div
              // Prevent input blur when clicking inside dropdown
              onMouseDown={(e) => e.preventDefault()}
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                background: '#fff',
                border: '1px solid #e2e5eb',
                borderTop: 'none',
                borderRadius: '0 0 10px 10px',
                boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
                zIndex: 100,
                maxHeight: 260,
                overflowY: 'auto',
              }}
            >
              {suggestions.map((s, i) => (
                <button
                  key={s.sym}
                  type="button"
                  // Use onPointerDown to select — fires before blur.
                  // The click guard blocks any click events from reaching
                  // elements underneath after the dropdown is removed.
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    selectSymbol(s.sym);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    width: '100%',
                    padding: '8px 14px',
                    border: 'none',
                    background: i === selectedIdx ? '#eff6ff' : '#fff',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: 13,
                    fontFamily: 'inherit',
                    borderBottom: i < suggestions.length - 1 ? '1px solid #f1f3f7' : 'none',
                  }}
                >
                  <span style={{ fontWeight: 700, fontFamily: mono, color: '#1a1d26', minWidth: 70 }}>
                    {s.sym}
                  </span>
                  {s.name && (
                    <span style={{ color: '#64748b', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.name}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => { onScan(); setFocused(false); }}
          disabled={loading}
          style={{
            minHeight: 44,
            minWidth: 80,
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

      {/* Universe link */}
      {typeof onOpenStockList === 'function' && (
        <button
          type="button"
          onClick={onOpenStockList}
          title={universeLabel ? `Browse ${universeLabel}` : 'Browse stock list'}
          style={{
            marginTop: 6,
            padding: '2px 0',
            fontSize: 11,
            fontWeight: 600,
            background: 'none',
            border: 'none',
            color: '#2563eb',
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          Browse {universeLabel || 'stocks'} →
        </button>
      )}
    </div>
  );
}
