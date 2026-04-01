import { useEffect, useState } from 'react';

/**
 * Detects new service worker and shows a "tap to update" banner.
 * Works with vite-plugin-pwa registerType: 'prompt'.
 *
 * Also shows a transient "Checking for updates..." indicator when
 * a manual check is triggered (debug toggle).
 */
export default function UpdatePrompt() {
  const [showUpdate, setShowUpdate] = useState(false);
  const [registration, setRegistration] = useState(null);
  const [checking, setChecking] = useState(false);
  const [newVersion, setNewVersion] = useState('');

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const handleSWUpdate = async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return;

      if (reg.waiting) {
        setRegistration(reg);
        setShowUpdate(true);
        setChecking(false);
        fetchNewVersion();
        return;
      }

      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (!newSW) return;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            setRegistration(reg);
            setShowUpdate(true);
            setChecking(false);
            fetchNewVersion();
          }
        });
      });
    };

    handleSWUpdate();

    const onManualCheck = () => {
      setChecking(true);
      navigator.serviceWorker.getRegistration().then(r => r?.update()).catch(() => {});
      // Check multiple times — CDN may cache sw.js for up to 10 min
      const t1 = setTimeout(() => handleSWUpdate(), 2000);
      const t2 = setTimeout(() => handleSWUpdate(), 5000);
      const t3 = setTimeout(() => {
        handleSWUpdate();
        // If still no update after 10s, dismiss the checking indicator
        setChecking(prev => {
          // Only dismiss if we haven't found an update
          if (!showUpdate) return false;
          return prev;
        });
      }, 10000);

      // Final dismiss at 12s regardless
      const t4 = setTimeout(() => setChecking(false), 12000);

      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
    };

    window.addEventListener('candlescan:check-update', onManualCheck);
    return () => window.removeEventListener('candlescan:check-update', onManualCheck);
  }, []);

  // Fetch the new version from the <meta name="app-version"> tag in the deployed index.html
  const fetchNewVersion = async () => {
    try {
      const res = await fetch(window.location.pathname + '?_=' + Date.now(), { cache: 'no-store' });
      const html = await res.text();
      const match = html.match(/<meta\s+name="app-version"\s+content="([^"]+)"/);
      if (match) setNewVersion(match[1]);
    } catch { /* ignore */ }
  };

  const handleUpdate = () => {
    if (registration?.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
    setShowUpdate(false);
    setChecking(false);
    setTimeout(() => window.location.reload(), 500);
  };

  return (
    <>
      {/* Transient "checking" indicator */}
      {checking && !showUpdate && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10000,
          padding: '6px 16px', background: '#f0f4ff', color: '#4a5068',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 500, gap: 8,
          borderBottom: '1px solid #e2e5eb',
          animation: 'fadeIn 0.2s ease-out',
        }}>
          <span style={{
            display: 'inline-block', width: 12, height: 12,
            border: '2px solid #2563eb', borderTopColor: 'transparent',
            borderRadius: '50%', animation: 'spin 0.8s linear infinite',
          }} />
          Checking for updates...
        </div>
      )}

      {/* Update available banner */}
      {showUpdate && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10000,
          padding: '10px 16px', background: '#2563eb', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontSize: 13, fontWeight: 600,
          boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
        }}>
          <span>
            New version available{newVersion ? ` (${newVersion})` : ''}
          </span>
          <button
            type="button"
            onClick={handleUpdate}
            style={{
              padding: '6px 16px', fontSize: 12, fontWeight: 700,
              borderRadius: 6, border: 'none',
              background: '#fff', color: '#2563eb', cursor: 'pointer',
            }}
          >
            Update now
          </button>
        </div>
      )}

      {/* Keyframe animations */}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </>
  );
}
