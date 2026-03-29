import { useState, useCallback } from 'react';
import { fetchNseIndexSymbolList } from '../engine/nseIndexFetch.js';

/**
 * Inline input to search and add a custom NSE index.
 * Validates against the live NSE API before adding.
 *
 * @param {{ onAdd: (indexId: string) => void }} props
 */
export default function CustomIndexInput({ onAdd }) {
  const [val, setVal] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleAdd = useCallback(async () => {
    const name = val.trim().toUpperCase();
    if (!name) return;
    setLoading(true);
    setError('');
    try {
      const syms = await fetchNseIndexSymbolList(name);
      if (syms?.length) {
        onAdd(name);
        setVal('');
      } else {
        setError('No stocks found for this index');
      }
    } catch {
      setError('Index not found on NSE');
    } finally {
      setLoading(false);
    }
  }, [val, onAdd]);

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={val}
          onChange={(e) => { setVal(e.target.value); setError(''); }}
          onKeyDown={(e) => e.key === 'Enter' && !loading && handleAdd()}
          placeholder="Add custom index..."
          disabled={loading}
          style={{
            flex: 1, padding: '8px 10px', fontSize: 12, borderRadius: 6,
            border: '1px solid #e2e5eb', outline: 'none', boxSizing: 'border-box',
            color: '#1a1d26', opacity: loading ? 0.5 : 1,
          }}
        />
        <button
          type="button"
          onClick={handleAdd}
          disabled={loading || !val.trim()}
          style={{
            padding: '0 12px', fontSize: 12, fontWeight: 600, borderRadius: 6,
            border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer',
            opacity: loading || !val.trim() ? 0.5 : 1, whiteSpace: 'nowrap',
          }}
        >
          {loading ? '...' : 'Add'}
        </button>
      </div>
      {error && (
        <div style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>{error}</div>
      )}
    </div>
  );
}
