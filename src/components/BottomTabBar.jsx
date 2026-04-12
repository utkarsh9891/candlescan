/**
 * BottomTabBar — fixed bottom navigation bar.
 *
 * Replaces the hamburger's confusing toggle-label nav items with a
 * standard bottom tab bar (same pattern as Zerodha Kite, Groww, Dhan).
 * Active tab is highlighted. Simple Mode hides expert-only tabs
 * (Simulate, Paper) since those views aren't useful without technical
 * context.
 *
 * The hamburger menu stays but becomes a "configuration" panel
 * (engine, signal filters, custom indices) — not a navigation menu.
 */

const TAB_HEIGHT = 48;  // Compact — same as Zerodha Kite's bottom bar

const tabs = [
  {
    key: 'batch',
    label: 'Scan',
    expertOnly: false,
    icon: (color) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    ),
  },
  {
    key: 'main',
    label: 'Stock',
    expertOnly: false,
    icon: (color) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
  },
  {
    key: 'simulate',
    label: 'Simulate',
    expertOnly: true,
    icon: (color) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    ),
  },
  {
    key: 'paper',
    label: 'Paper',
    expertOnly: true,
    icon: (color) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="12" y1="18" x2="12" y2="12" />
        <line x1="9" y1="15" x2="15" y2="15" />
      </svg>
    ),
  },
  // Settings is accessed via the gear icon in the Header, not via
  // a bottom tab — it's a secondary surface, not a primary workflow.
];

export default function BottomTabBar({ view, setView, noviceMode }) {
  const visibleTabs = noviceMode
    ? tabs.filter(t => !t.expertOnly)
    : tabs;

  return (
    <nav style={{
      position: 'fixed',
      bottom: 0,
      left: '50%',
      transform: 'translateX(-50%)',
      width: '100%',
      maxWidth: 620,
      height: TAB_HEIGHT,
      background: '#fff',
      borderTop: '1px solid #e2e5eb',
      display: 'flex',
      alignItems: 'stretch',
      zIndex: 200,
      boxSizing: 'border-box',
      // Safe area for phones with gesture bars (iPhone X+, modern Android)
      paddingBottom: 'env(safe-area-inset-bottom, 0px)',
    }}>
      {visibleTabs.map((tab) => {
        const active = view === tab.key;
        const color = active ? '#2563eb' : '#8892a8';
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => setView(tab.key)}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              border: 'none',
              background: active ? '#eff6ff' : 'transparent',
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
              padding: 0,
              borderTop: active ? '2px solid #2563eb' : '2px solid transparent',
              transition: 'background 0.15s',
            }}
            aria-current={active ? 'page' : undefined}
          >
            {tab.icon(color)}
            <span style={{
              fontSize: 10,
              fontWeight: active ? 700 : 500,
              color,
              lineHeight: 1,
            }}>
              {tab.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

export { TAB_HEIGHT };
