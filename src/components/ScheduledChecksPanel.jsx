/**
 * ScheduledChecksPanel — global banner + collapsible list that shows
 * pending and recently-fired scheduled checks.
 *
 * Mounted once at the App.jsx level (below Header, above all views)
 * so it's visible regardless of the current view — the user can walk
 * away from Novice Mode, tap around Settings, come back to the Stock
 * Scanner, and still see "RELIANCE converted 30 s ago".
 *
 * Behaviour:
 *   - Hidden entirely when there are zero schedules.
 *   - When there are pending schedules, shows a compact strip with
 *     the count and an expand/collapse chevron.
 *   - When expanded, lists each schedule with: symbol, direction,
 *     countdown (for pending) or result badge (for done/error),
 *     dismiss button, and a tap target that calls `onOpen(symbol)`
 *     to drill into the stock detail view.
 *   - Done schedules display a green "✅ CONVERTED" or amber "⏳ Still
 *     not ready" badge and stay pinned until dismissed so the user
 *     can see them even if they weren't watching at fire time.
 */

import { useState, useEffect } from 'react';

const mono = "'SF Mono', Menlo, monospace";

function formatCountdown(ms) {
  if (ms <= 0) return 'firing…';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`;
}

function formatAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  const mins = Math.round(diff / 60000);
  return `${mins} min ago`;
}

function StatusBadge({ check }) {
  if (check.status === 'pending') {
    return (
      <span style={{
        padding: '2px 6px', borderRadius: 4, fontSize: 9, fontWeight: 700,
        background: '#eff6ff', color: '#1d4ed8',
      }}>
        PENDING
      </span>
    );
  }
  if (check.status === 'running') {
    return (
      <span style={{
        padding: '2px 6px', borderRadius: 4, fontSize: 9, fontWeight: 700,
        background: '#fefce8', color: '#a16207',
      }}>
        CHECKING…
      </span>
    );
  }
  if (check.status === 'error') {
    return (
      <span style={{
        padding: '2px 6px', borderRadius: 4, fontSize: 9, fontWeight: 700,
        background: '#fef2f2', color: '#991b1b',
      }}>
        FAILED
      </span>
    );
  }
  // done
  if (check.converted) {
    return (
      <span style={{
        padding: '2px 6px', borderRadius: 4, fontSize: 9, fontWeight: 800,
        background: '#dcfce7', color: '#166534',
      }}>
        ✅ CONVERTED
      </span>
    );
  }
  // done but not converted
  const afterClass = check.afterClass;
  const still = afterClass === 'imminent'
    ? 'STILL CLOSE'
    : afterClass === 'building'
      ? 'STILL BUILDING'
      : afterClass === 'early'
        ? 'STILL EARLY'
        : 'NOT READY';
  return (
    <span style={{
      padding: '2px 6px', borderRadius: 4, fontSize: 9, fontWeight: 700,
      background: '#fef3c7', color: '#92400e',
    }}>
      ⏳ {still}
    </span>
  );
}

function CheckRow({ check, onOpen, onDismiss, nowTs }) {
  const pending = check.status === 'pending';
  const running = check.status === 'running';
  const done = check.status === 'done' || check.status === 'error';
  const countdownMs = pending ? Math.max(0, check.scheduledAt - nowTs) : 0;

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
        borderTop: '1px solid #eef0f4', cursor: 'pointer',
      }}
      onClick={() => onOpen?.(check.symbol)}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#1a1d26' }}>{check.symbol}</span>
          {check.direction && (
            <span style={{
              padding: '1px 5px', borderRadius: 3, fontSize: 9, fontWeight: 700,
              background: check.direction === 'long' ? '#dcfce7' : '#fee2e2',
              color: check.direction === 'long' ? '#16a34a' : '#dc2626',
            }}>
              {check.direction === 'long' ? 'LONG' : 'SHORT'}
            </span>
          )}
          <StatusBadge check={check} />
        </div>
        <div style={{ fontSize: 11, color: '#64748b' }}>
          {pending && (
            <span style={{ fontFamily: mono }}>firing in {formatCountdown(countdownMs)}</span>
          )}
          {running && <span>running single-symbol re-scan…</span>}
          {done && check.status === 'done' && (
            <span>
              {check.converted
                ? `🎉 ready to trade · ${formatAgo(check.firedAt)}`
                : `fired ${formatAgo(check.firedAt)}`}
              {check.result && !check.converted && check.afterClass !== 'ignore' && (
                <span style={{ color: '#94a3b8' }}>
                  {' '}· still worth watching
                </span>
              )}
            </span>
          )}
          {done && check.status === 'error' && (
            <span style={{ color: '#dc2626' }}>{check.errorMsg || 'check failed'}</span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDismiss?.(check.id); }}
        aria-label="Dismiss scheduled check"
        style={{
          width: 26, height: 26, borderRadius: 6, padding: 0,
          border: '1px solid #e2e5eb', background: '#fff', color: '#8892a8',
          cursor: 'pointer', fontSize: 14, lineHeight: 1, flexShrink: 0,
        }}
      >×</button>
    </div>
  );
}

export default function ScheduledChecksPanel({ scheduledChecks, onOpen }) {
  const [expanded, setExpanded] = useState(false);
  const [nowTs, setNowTs] = useState(Date.now());

  // Live clock so pending countdowns refresh
  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!scheduledChecks) return null;
  const checks = scheduledChecks.checks || [];
  if (checks.length === 0) return null;

  const pending = checks.filter(c => c.status === 'pending').length;
  const running = checks.filter(c => c.status === 'running').length;
  const converted = checks.filter(c => c.status === 'done' && c.converted).length;
  const done = checks.filter(c => c.status === 'done' || c.status === 'error').length;

  // Soonest pending schedule — shown on the collapsed strip
  let soonest = null;
  for (const c of checks) {
    if (c.status !== 'pending') continue;
    if (!soonest || c.scheduledAt < soonest.scheduledAt) soonest = c;
  }

  // Badge color: green if any converted, amber if pending, gray if just done
  const barColor = converted > 0
    ? '#16a34a'
    : running > 0
      ? '#d97706'
      : pending > 0
        ? '#2563eb'
        : '#94a3b8';

  return (
    <div style={{
      marginBottom: 10, borderRadius: 10, overflow: 'hidden',
      border: `1px solid ${barColor}33`, background: '#fff',
      boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
    }}>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 12px', background: 'none', border: 'none',
          cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
          borderLeft: `3px solid ${barColor}`,
        }}
      >
        <span style={{ fontSize: 16 }}>⏰</span>
        <div style={{ flex: 1, textAlign: 'left' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#1a1d26' }}>
            Scheduled checks
          </div>
          <div style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>
            {pending > 0 && <span>{pending} pending</span>}
            {running > 0 && <span>{pending > 0 ? ' · ' : ''}{running} running</span>}
            {converted > 0 && <span>{(pending || running) ? ' · ' : ''}<strong style={{ color: '#16a34a' }}>{converted} converted</strong></span>}
            {done > converted && <span>{(pending || running || converted) ? ' · ' : ''}{done - converted} complete</span>}
            {soonest && pending > 0 && (
              <span style={{ marginLeft: 6, fontFamily: mono }}>
                · next in {formatCountdown(Math.max(0, soonest.scheduledAt - nowTs))}
              </span>
            )}
          </div>
        </div>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div>
          {checks.map(c => (
            <CheckRow
              key={c.id}
              check={c}
              onOpen={onOpen}
              onDismiss={scheduledChecks.dismiss}
              nowTs={nowTs}
            />
          ))}
          {done > 0 && (
            <div style={{
              padding: '8px 12px', borderTop: '1px solid #eef0f4',
              display: 'flex', justifyContent: 'flex-end',
            }}>
              <button
                type="button"
                onClick={() => scheduledChecks.dismissAllDone?.()}
                style={{
                  padding: '4px 10px', fontSize: 10, fontWeight: 600,
                  borderRadius: 5, border: '1px solid #e2e5eb',
                  background: '#fff', color: '#64748b', cursor: 'pointer',
                }}
              >
                Clear completed
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
