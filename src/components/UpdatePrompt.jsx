import { useEffect, useState, useRef } from 'react';

/**
 * Detects new service worker OR stale cached app shell and shows update banner.
 *
 * Detection methods (in order):
 *  1. SW waiting state — a new SW is already downloaded and waiting
 *  2. SW updatefound event — browser detects sw.js changed on server
 *  3. Version mismatch fallback — if SW is current but cached HTML is stale,
 *     compare deployed <meta app-version> against __APP_VERSION__. This catches
 *     the case where the SW was updated on a previous visit but the user never
 *     tapped "Update now", and the waiting SW was later discarded by the browser.
 */
export default function UpdatePrompt() {
  const [showUpdate, setShowUpdate] = useState(false);
  const [registration, setRegistration] = useState(null);
  const [checking, setChecking] = useState(false);
  const [newVersion, setNewVersion] = useState('');
  const [forceReload, setForceReload] = useState(false); // true = no waiting SW, just reload
  const [checkError, setCheckError] = useState('');
  const foundRef = useRef(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const markFound = (reg) => {
      foundRef.current = true;
      if (reg) setRegistration(reg);
      setShowUpdate(true);
      setChecking(false);
      fetchNewVersion();
    };

    const handleSWUpdate = async () => {
      if (foundRef.current) return;
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return;

      // Check if a new SW is already waiting
      if (reg.waiting) {
        markFound(reg);
        return;
      }

      // Listen for future updatefound (only attach once)
      if (!reg._csScanListening) {
        reg._csScanListening = true;
        reg.addEventListener('updatefound', () => {
          const newSW = reg.installing;
          if (!newSW) return;
          newSW.addEventListener('statechange', () => {
            if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
              markFound(reg);
            }
          });
        });
      }
    };

    handleSWUpdate();

    const onManualCheck = () => {
      foundRef.current = false;
      setChecking(true);
      setCheckError('');

      // Force browser to re-fetch sw.js from server
      navigator.serviceWorker.getRegistration().then(r => r?.update()).catch(() => {});

      // Check SW state at 2s and 5s
      const t1 = setTimeout(() => handleSWUpdate(), 2000);
      const t2 = setTimeout(() => handleSWUpdate(), 5000);

      // At 8s: if SW check found nothing, fall back to version comparison
      const t3 = setTimeout(async () => {
        if (foundRef.current) return;
        await handleSWUpdate();
        if (foundRef.current) return;

        // Fallback: directly compare deployed version vs running version
        try {
          const deployedVersion = await fetchDeployedVersion();
          const currentVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';
          if (deployedVersion && currentVersion && deployedVersion !== currentVersion) {
            setNewVersion(deployedVersion);
            setForceReload(true);
            setShowUpdate(true);
            setChecking(false);
            foundRef.current = true;
          } else if (deployedVersion) {
            setChecking(false);
            // Version matches — genuinely up to date
          } else {
            setChecking(false);
            setCheckError('Could not reach server to check for updates. Please check your network connection.');
          }
        } catch (e) {
          setChecking(false);
          const msg = e?.message?.includes('fetch') || e?.message?.includes('network') || e?.name === 'TypeError'
            ? 'Network error — could not check for updates. Please check your connection and try again.'
            : 'Could not check for updates. Please try again later.';
          setCheckError(msg);
        }
      }, 8000);

      // Final dismiss at 15s regardless
      const t4 = setTimeout(() => setChecking(false), 15000);

      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
    };

    window.addEventListener('candlescan:check-update', onManualCheck);
    return () => window.removeEventListener('candlescan:check-update', onManualCheck);
  }, []);

  const fetchDeployedVersion = async () => {
    const res = await fetch(window.location.pathname + '?_=' + Date.now(), { cache: 'no-store' });
    const html = await res.text();
    const match = html.match(/<meta\s+name="app-version"\s+content="([^"]+)"/);
    return match ? match[1] : null;
  };

  const fetchNewVersion = async () => {
    const v = await fetchDeployedVersion();
    if (v) setNewVersion(v);
  };

  const handleUpdate = () => {
    if (!forceReload && registration?.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      setShowUpdate(false);
      setChecking(false);
      setTimeout(() => window.location.reload(), 500);
    } else {
      // Force reload: unregister SW, clear caches, hard reload
      setShowUpdate(false);
      setChecking(false);
      (async () => {
        try {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg) await reg.unregister();
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        } catch { /* best effort */ }
        window.location.reload();
      })();
    }
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

      {/* Network error banner */}
      {checkError && !checking && !showUpdate && (
        <div onClick={() => setCheckError('')} style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10000,
          padding: '8px 16px', background: '#fef2f2', color: '#991b1b',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 500, gap: 6, cursor: 'pointer',
          borderBottom: '1px solid #fecaca',
          animation: 'fadeIn 0.2s ease-out',
        }}>
          <span style={{ fontSize: 14 }}>&#9888;</span>
          {checkError}
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
            {forceReload ? 'Update available' : 'New version available'}
            {newVersion ? ` (${newVersion})` : ''}
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

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </>
  );
}
