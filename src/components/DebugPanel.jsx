import { useState, useEffect, useRef } from 'react';

const mono = "'SF Mono', Menlo, monospace";

/**
 * In-app debug panel — shows API calls, timing, and status codes.
 * Intercepts globalThis.fetch when enabled.
 */
export default function DebugPanel({ open, onClose }) {
  const [logs, setLogs] = useState([]);
  const originalFetch = useRef(null);
  const idRef = useRef(0);

  useEffect(() => {
    if (!open) {
      // Restore original fetch when closed
      if (originalFetch.current) {
        globalThis.fetch = originalFetch.current;
        originalFetch.current = null;
      }
      return;
    }

    // Intercept fetch
    if (!originalFetch.current) {
      originalFetch.current = globalThis.fetch;
    }
    const real = originalFetch.current;

    globalThis.fetch = async function (...args) {
      const id = ++idRef.current;
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '?';
      const method = args[1]?.method || 'GET';
      const hasToken = !!(args[1]?.headers?.['X-Batch-Token']);
      const start = performance.now();

      // Truncate URL for display
      let shortUrl = url;
      try {
        const u = new URL(url);
        const targetParam = u.searchParams.get('url');
        if (targetParam) {
          const tu = new URL(targetParam);
          shortUrl = `CF → ${tu.pathname.split('/').pop()}${tu.search.slice(0, 40)}`;
        } else {
          shortUrl = `${u.hostname}${u.pathname.slice(0, 30)}`;
        }
      } catch { shortUrl = url.slice(0, 60); }

      const entry = { id, method, url: shortUrl, fullUrl: url, hasToken, status: '...', time: 0, ts: new Date().toLocaleTimeString() };
      setLogs(prev => [entry, ...prev].slice(0, 50)); // keep last 50

      try {
        const res = await real.apply(globalThis, args);
        const elapsed = Math.round(performance.now() - start);
        setLogs(prev => prev.map(e => e.id === id ? { ...e, status: res.status, time: elapsed } : e));
        return res;
      } catch (err) {
        const elapsed = Math.round(performance.now() - start);
        setLogs(prev => prev.map(e => e.id === id ? { ...e, status: 'ERR', time: elapsed, error: err.message } : e));
        throw err;
      }
    };

    return () => {
      if (originalFetch.current) {
        globalThis.fetch = originalFetch.current;
        originalFetch.current = null;
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9000,
      maxHeight: '40vh', background: '#1a1d26', color: '#e2e5eb',
      borderTop: '2px solid #2563eb', overflow: 'auto',
      fontFamily: mono, fontSize: 11,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
        background: '#1a1d26', position: 'sticky', top: 0, borderBottom: '1px solid #333',
      }}>
        <span style={{ fontWeight: 700, color: '#2563eb' }}>Debug</span>
        <span style={{ color: '#8892a8' }}>{logs.length} requests</span>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={() => setLogs([])}
          style={{ fontSize: 10, color: '#8892a8', background: 'none', border: '1px solid #444', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}>
          Clear
        </button>
        <button type="button" onClick={onClose}
          style={{ fontSize: 14, color: '#8892a8', background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px' }}>
          ×
        </button>
      </div>

      {/* Log entries */}
      {logs.map(e => (
        <div key={e.id} style={{
          display: 'flex', gap: 8, padding: '4px 12px', borderBottom: '1px solid #2a2d36',
          alignItems: 'center',
        }}>
          <span style={{ color: '#8892a8', width: 55, flexShrink: 0 }}>{e.ts}</span>
          <span style={{
            width: 30, textAlign: 'center', flexShrink: 0, fontWeight: 700,
            color: e.status === 200 || e.status === 204 ? '#16a34a' : e.status === '...' ? '#d97706' : '#dc2626',
          }}>
            {e.status}
          </span>
          <span style={{ color: '#8892a8', width: 30, flexShrink: 0 }}>{e.time ? `${e.time}ms` : ''}</span>
          <span style={{
            flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            color: e.hasToken ? '#16a34a' : '#e2e5eb',
          }} title={e.fullUrl}>
            {e.hasToken ? '🔑 ' : ''}{e.url}
          </span>
          {e.error && <span style={{ color: '#dc2626', flexShrink: 0 }}>{e.error}</span>}
        </div>
      ))}

      {logs.length === 0 && (
        <div style={{ padding: 16, textAlign: 'center', color: '#8892a8' }}>
          Waiting for API calls... Scan a stock or run a batch scan.
        </div>
      )}
    </div>
  );
}
