import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';

/**
 * Error boundary that catches React crashes and shows a recovery UI.
 * This ensures users can always force-update the PWA even if the JS bundle
 * has a fatal error — without this, a broken cached version leaves the user
 * stuck on a grey screen with no way to recover.
 */
class CrashRecovery extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  handleForceUpdate = async () => {
    try {
      // Unregister all service workers
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
      // Clear all caches
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch { /* best effort */ }
    // Hard reload
    window.location.reload();
  };

  handleClearData = () => {
    try { localStorage.clear(); } catch { /* ok */ }
    try { sessionStorage.clear(); } catch { /* ok */ }
    this.handleForceUpdate();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return React.createElement('div', {
      style: {
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', padding: 24,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
        background: '#f5f6f8', color: '#1a1d26', textAlign: 'center',
      },
    },
      React.createElement('h1', { style: { fontSize: 20, marginBottom: 8 } }, 'CandleScan'),
      React.createElement('p', {
        style: { fontSize: 14, color: '#64748b', marginBottom: 24, maxWidth: 300 },
      }, 'Something went wrong. This usually means the app needs an update.'),
      React.createElement('button', {
        onClick: this.handleForceUpdate,
        style: {
          padding: '12px 24px', fontSize: 14, fontWeight: 600,
          borderRadius: 8, border: 'none', cursor: 'pointer',
          background: '#2563eb', color: '#fff', marginBottom: 12,
        },
      }, 'Update & Reload'),
      React.createElement('button', {
        onClick: this.handleClearData,
        style: {
          padding: '10px 20px', fontSize: 12, fontWeight: 500,
          borderRadius: 8, border: '1px solid #e2e5eb', cursor: 'pointer',
          background: '#fff', color: '#64748b',
        },
      }, 'Clear All Data & Reload'),
      React.createElement('p', {
        style: { fontSize: 11, color: '#8892a8', marginTop: 24, maxWidth: 300 },
      }, String(this.state.error?.message || '')),
    );
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  React.createElement(React.StrictMode, null,
    React.createElement(CrashRecovery, null,
      React.createElement(App)
    )
  )
);
