import { useState, useEffect, useRef } from 'react';

const mono = "'SF Mono', Menlo, monospace";

/**
 * In-app debug panel — shows API calls with copyable request/response details.
 * Intercepts globalThis.fetch when enabled.
 */
export default function DebugPanel({ open, onClose }) {
  const [logs, setLogs] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const originalFetch = useRef(null);
  const idRef = useRef(0);

  useEffect(() => {
    if (!open) {
      if (originalFetch.current) {
        globalThis.fetch = originalFetch.current;
        originalFetch.current = null;
      }
      return;
    }

    if (!originalFetch.current) {
      originalFetch.current = globalThis.fetch;
    }
    const real = originalFetch.current;

    globalThis.fetch = async function (...args) {
      const id = ++idRef.current;
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '?';
      const method = args[1]?.method || 'GET';
      const reqHeaders = args[1]?.headers || {};
      const hasToken = !!reqHeaders['X-Batch-Token'];
      const start = performance.now();

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

      const entry = {
        id, method, url: shortUrl, fullUrl: url, hasToken,
        reqHeaders: { ...reqHeaders },
        status: '...', time: 0, ts: new Date().toLocaleTimeString(),
        resHeaders: {}, resBody: null, error: null,
      };
      setLogs(prev => [entry, ...prev].slice(0, 50));

      try {
        const res = await real.apply(globalThis, args);
        const elapsed = Math.round(performance.now() - start);

        // Capture response headers
        const rh = {};
        res.headers.forEach((v, k) => { rh[k] = v; });

        // Clone response to read body without consuming it
        const clone = res.clone();
        let resBody = null;
        try {
          const text = await clone.text();
          resBody = text.length > 5000 ? text.slice(0, 5000) + '...(truncated)' : text;
        } catch { resBody = '(could not read body)'; }

        setLogs(prev => prev.map(e => e.id === id
          ? { ...e, status: res.status, time: elapsed, resHeaders: rh, resBody }
          : e
        ));
        return res;
      } catch (err) {
        const elapsed = Math.round(performance.now() - start);
        setLogs(prev => prev.map(e => e.id === id
          ? { ...e, status: 'ERR', time: elapsed, error: err.message }
          : e
        ));
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

  // Collapsed: thin bottom bar with request count, tap to expand
  if (collapsed) {
    const errCount = logs.filter(e => e.status !== 200 && e.status !== 204 && e.status !== '...').length;
    return (
      <div
        onClick={() => setCollapsed(false)}
        style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9000,
          height: 28, background: '#1a1d26', color: '#8892a8',
          borderTop: '2px solid #2563eb',
          display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px',
          fontFamily: mono, fontSize: 10, cursor: 'pointer',
        }}
      >
        <span style={{ fontWeight: 700, color: '#2563eb' }}>Debug</span>
        <span>{logs.length} req{logs.length !== 1 ? 's' : ''}</span>
        {errCount > 0 && <span style={{ color: '#dc2626' }}>{errCount} err</span>}
        <div style={{ flex: 1 }} />
        <span style={{ color: '#555' }}>tap to expand ▴</span>
        <button type="button" onClick={(ev) => { ev.stopPropagation(); onClose(); }}
          style={{ fontSize: 14, color: '#8892a8', background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px' }}>
          ×
        </button>
      </div>
    );
  }

  function copyToClipboard(text) {
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  function formatEntryForCopy(e) {
    const lines = [
      `${e.method} ${e.fullUrl}`,
      `Status: ${e.status} | Time: ${e.time}ms`,
      '',
      '--- Request Headers ---',
      ...Object.entries(e.reqHeaders).map(([k, v]) => `${k}: ${v}`),
    ];
    if (Object.keys(e.resHeaders).length) {
      lines.push('', '--- Response Headers ---');
      lines.push(...Object.entries(e.resHeaders).map(([k, v]) => `${k}: ${v}`));
    }
    if (e.resBody) {
      lines.push('', '--- Response Body ---', e.resBody);
    }
    if (e.error) {
      lines.push('', `--- Error ---`, e.error);
    }
    return lines.join('\n');
  }

  const btnStyle = {
    fontSize: 9, color: '#8892a8', background: 'none',
    border: '1px solid #444', borderRadius: 3, padding: '1px 6px',
    cursor: 'pointer', flexShrink: 0,
  };

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9000,
      maxHeight: '50vh', background: '#1a1d26', color: '#e2e5eb',
      borderTop: '2px solid #2563eb', overflow: 'auto',
      fontFamily: mono, fontSize: 11,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
        background: '#1a1d26', position: 'sticky', top: 0, borderBottom: '1px solid #333', zIndex: 1,
      }}>
        <span style={{ fontWeight: 700, color: '#2563eb' }}>Debug</span>
        <span style={{ color: '#8892a8' }}>{logs.length} requests</span>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={() => {
          const all = logs.map(formatEntryForCopy).join('\n\n═══════════════\n\n');
          copyToClipboard(all);
        }} style={btnStyle}>
          Copy All
        </button>
        <button type="button" onClick={() => { setLogs([]); setExpandedId(null); }} style={btnStyle}>
          Clear
        </button>
        <button type="button" onClick={() => setCollapsed(true)}
          style={{ fontSize: 12, color: '#8892a8', background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px' }}
          title="Collapse to bottom bar">
          ▾
        </button>
        <button type="button" onClick={onClose}
          style={{ fontSize: 14, color: '#8892a8', background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px' }}>
          ×
        </button>
      </div>

      {/* Log entries */}
      {logs.map(e => (
        <div key={e.id}>
          {/* Summary row — tap to expand */}
          <div
            onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}
            style={{
              display: 'flex', gap: 8, padding: '4px 12px', borderBottom: '1px solid #2a2d36',
              alignItems: 'center', cursor: 'pointer',
              background: expandedId === e.id ? '#2a2d36' : 'transparent',
            }}
          >
            <span style={{ color: '#555', flexShrink: 0 }}>{expandedId === e.id ? '▾' : '▸'}</span>
            <span style={{ color: '#8892a8', width: 55, flexShrink: 0 }}>{e.ts}</span>
            <span style={{
              width: 30, textAlign: 'center', flexShrink: 0, fontWeight: 700,
              color: e.status === 200 || e.status === 204 ? '#16a34a' : e.status === '...' ? '#d97706' : '#dc2626',
            }}>
              {e.status}
            </span>
            <span style={{ color: '#8892a8', width: 38, flexShrink: 0 }}>{e.time ? `${e.time}ms` : ''}</span>
            <span style={{
              flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              color: e.hasToken ? '#16a34a' : '#e2e5eb',
            }} title={e.fullUrl}>
              {e.hasToken ? '🔑 ' : ''}{e.url}
            </span>
            <button type="button" onClick={(ev) => { ev.stopPropagation(); copyToClipboard(formatEntryForCopy(e)); }}
              style={btnStyle}>
              Copy
            </button>
          </div>

          {/* Expanded detail */}
          {expandedId === e.id && (
            <div style={{ padding: '8px 12px 8px 32px', background: '#22252e', borderBottom: '1px solid #2a2d36', fontSize: 10, lineHeight: 1.6 }}>
              <div style={{ color: '#8892a8', marginBottom: 4 }}>
                <strong style={{ color: '#e2e5eb' }}>{e.method}</strong> {e.fullUrl}
              </div>

              {Object.keys(e.reqHeaders).length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ color: '#2563eb', fontWeight: 700, marginBottom: 2 }}>Request Headers</div>
                  {Object.entries(e.reqHeaders).map(([k, v]) => (
                    <div key={k} style={{ color: '#8892a8' }}>
                      <span style={{ color: '#d97706' }}>{k}</span>: {
                        k === 'X-Batch-Token' ? v.slice(0, 8) + '...' + v.slice(-4) : v
                      }
                    </div>
                  ))}
                </div>
              )}

              {Object.keys(e.resHeaders).length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ color: '#16a34a', fontWeight: 700, marginBottom: 2 }}>Response Headers</div>
                  {Object.entries(e.resHeaders).map(([k, v]) => (
                    <div key={k} style={{ color: '#8892a8' }}>
                      <span style={{ color: '#d97706' }}>{k}</span>: {v}
                    </div>
                  ))}
                </div>
              )}

              {e.resBody && (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span style={{ color: '#16a34a', fontWeight: 700 }}>Response Body</span>
                    <button type="button" onClick={() => copyToClipboard(e.resBody)} style={btnStyle}>Copy Body</button>
                  </div>
                  <pre style={{
                    margin: 0, padding: 6, background: '#1a1d26', borderRadius: 4,
                    maxHeight: 150, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                    color: '#8892a8', fontSize: 9,
                  }}>
                    {e.resBody}
                  </pre>
                </div>
              )}

              {e.error && (
                <div style={{ color: '#dc2626', marginTop: 4 }}>
                  <strong>Error:</strong> {e.error}
                </div>
              )}
            </div>
          )}
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
