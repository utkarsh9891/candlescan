import { useEffect, useState } from 'react';

/**
 * Detects new service worker and shows a "tap to update" banner.
 * Works with vite-plugin-pwa registerType: 'prompt'.
 */
export default function UpdatePrompt() {
  const [showUpdate, setShowUpdate] = useState(false);
  const [registration, setRegistration] = useState(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    // Listen for the PWA prompt event from vite-plugin-pwa
    const handleSWUpdate = async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return;

      // Check for waiting worker (new version installed but not active)
      if (reg.waiting) {
        setRegistration(reg);
        setShowUpdate(true);
        return;
      }

      // Listen for future updates
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (!newSW) return;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            setRegistration(reg);
            setShowUpdate(true);
          }
        });
      });
    };

    // Check on app launch
    handleSWUpdate();

    // Also check when debug mode is toggled (deliberate user action)
    const onManualCheck = () => {
      navigator.serviceWorker.getRegistration().then(r => r?.update()).catch(() => {});
      setTimeout(handleSWUpdate, 1000); // give SW time to fetch
    };
    window.addEventListener('candlescan:check-update', onManualCheck);
    return () => window.removeEventListener('candlescan:check-update', onManualCheck);
  }, []);

  const handleUpdate = () => {
    if (registration?.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
    setShowUpdate(false);
    // Reload after a brief delay to allow SW activation
    setTimeout(() => window.location.reload(), 500);
  };

  if (!showUpdate) return null;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10000,
      padding: '10px 16px', background: '#2563eb', color: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      fontSize: 13, fontWeight: 600,
      boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
    }}>
      <span>New version available</span>
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
  );
}
