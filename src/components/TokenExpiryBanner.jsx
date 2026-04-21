/**
 * TokenExpiryBanner — prominent reconnect prompt shown above scan
 * results when a broker session has expired.
 *
 * Phase A P1 #8 — before this banner existed, an expired Dhan / Kite
 * token produced an empty scan with no visible cause. batchScan now
 * surfaces `tokenError = { broker }` when any symbol's fetch throws
 * TokenExpiredError; this component renders on that signal and sends
 * the user to Settings to re-link.
 *
 * Inline styles only — project convention.
 */

const BROKER_LABEL = {
  dhan: 'Dhan',
  kite: 'Zerodha',
};

export default function TokenExpiryBanner({ broker, onOpenSettings }) {
  if (!broker) return null;
  const label = BROKER_LABEL[broker] || broker;

  return (
    <div
      role="alert"
      data-testid="token-expiry-banner"
      style={{
        padding: 14,
        borderRadius: 10,
        marginBottom: 12,
        background: '#fef2f2',
        border: '1px solid #fecaca',
        color: '#991b1b',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>
          {label} session expired
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.4, color: '#7f1d1d' }}>
          Your {label} session has expired. Please re-link from Settings to resume scanning.
        </div>
      </div>
      {onOpenSettings && (
        <button
          type="button"
          onClick={onOpenSettings}
          data-testid="token-expiry-reconnect-btn"
          style={{
            padding: '8px 14px',
            fontSize: 12,
            fontWeight: 700,
            borderRadius: 8,
            border: 'none',
            background: '#dc2626',
            color: '#fff',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Reconnect {label}
        </button>
      )}
    </div>
  );
}
