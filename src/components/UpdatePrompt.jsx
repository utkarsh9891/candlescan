import { useEffect, useState, useRef, useCallback } from 'react';

/**
 * Detects new versions via two mechanisms:
 *
 *  1. Passive SW detection — the browser naturally checks for SW updates;
 *     if a new SW is waiting, we surface the "Update now" banner.
 *  2. GitHub Release check — once per 24 h (or on manual trigger from Settings),
 *     fetches the latest release from the GitHub API and compares the tag
 *     against __APP_VERSION__. This is the single source of truth for versioning.
 */

const GITHUB_REPO = 'utkarsh9891/candlescan';
const CF_WORKER_URL = 'https://candlescan-proxy.utkarsh-dev.workers.dev';
const LS_LAST_CHECK = 'candlescan_last_update_check';
const LS_LATEST_VER = 'candlescan_latest_version';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Parse "vMAJOR.MINOR.PATCH" → [major, minor, patch] or null */
function parseSemver(v) {
  const m = String(v).match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

/** Returns true if `a` is strictly newer than `b` (both "vX.Y.Z" strings) */
function isNewer(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

export default function UpdatePrompt() {
  const [showUpdate, setShowUpdate] = useState(false);
  const [registration, setRegistration] = useState(null);
  const [checking, setChecking] = useState(false);
  const [newVersion, setNewVersion] = useState('');
  const [forceReload, setForceReload] = useState(false);
  const [checkError, setCheckError] = useState('');
  const foundRef = useRef(false);

  const currentVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';

  // ── Passive SW detection (no extra network requests) ──────────────
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.getRegistration().then(reg => {
      if (!reg) return;
      if (reg.waiting) {
        foundRef.current = true;
        setRegistration(reg);
        // Don't set newVersion from stale cache — banner will say "New version available"
        setShowUpdate(true);
        return;
      }
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            foundRef.current = true;
            setRegistration(reg);
            setShowUpdate(true);
          }
        });
      });
    });
  }, []);

  // ── GitHub Release check ──────────────────────────────────────────
  const checkGitHubRelease = useCallback(async (manual = false) => {
    if (!currentVersion) return;
    setChecking(true);
    setCheckError('');
    try {
      // Use /releases?per_page=1 (includes pre-releases) instead of
      // /releases/latest (which only returns full releases — 404 for 0.x.y)
      const ghUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=1`;
      let res;
      try {
        res = await fetch(ghUrl, { headers: { Accept: 'application/vnd.github+json' } });
      } catch {
        // Direct fetch failed (CORS/PNA on VPN networks) — route through CF worker
        res = await fetch(`${CF_WORKER_URL}/github/releases?repo=${GITHUB_REPO}`);
      }
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) {
        // No releases published yet
        setChecking(false);
        try { localStorage.setItem(LS_LAST_CHECK, String(Date.now())); } catch { /* quota */ }
        return;
      }
      const latest = data[0].tag_name;

      try {
        localStorage.setItem(LS_LAST_CHECK, String(Date.now()));
        localStorage.setItem(LS_LATEST_VER, latest);
      } catch { /* quota */ }

      if (isNewer(latest, currentVersion)) {
        setNewVersion(latest);
        setForceReload(true);
        setShowUpdate(true);
        foundRef.current = true;
      }
      setChecking(false);
    } catch (e) {
      setChecking(false);
      const msg = e?.message || '';
      const isNetwork = msg.includes('fetch') || msg.includes('network') || msg.includes('Failed') || !navigator.onLine;
      const hint = isNetwork
        ? 'Network error — check your connection and try again.'
        : `Could not check for updates (${msg || 'unknown error'}). Try again later.`;
      setCheckError(hint);
    }
  }, [currentVersion]);

  // Auto-check: once per 24 h on mount
  useEffect(() => {
    if (foundRef.current) return;
    try {
      const last = Number(localStorage.getItem(LS_LAST_CHECK) || '0');
      if (Date.now() - last < CHECK_INTERVAL_MS) {
        // Still within window — check cached result instead
        const cached = localStorage.getItem(LS_LATEST_VER);
        if (cached && isNewer(cached, currentVersion)) {
          setNewVersion(cached);
          setForceReload(true);
          setShowUpdate(true);
          foundRef.current = true;
        }
        return;
      }
    } catch { /* localStorage unavailable */ }
    checkGitHubRelease(false);
  }, [checkGitHubRelease, currentVersion]);

  // Auto-dismiss error banner after 6 seconds
  useEffect(() => {
    if (!checkError) return;
    const t = setTimeout(() => setCheckError(''), 6000);
    return () => clearTimeout(t);
  }, [checkError]);

  // Manual trigger from Settings "Check for updates" button
  useEffect(() => {
    const onManual = () => checkGitHubRelease(true);
    window.addEventListener('candlescan:check-update', onManual);
    return () => window.removeEventListener('candlescan:check-update', onManual);
  }, [checkGitHubRelease]);

  // ── Update action ─────────────────────────────────────────────────
  const handleUpdate = () => {
    if (!forceReload && registration?.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      setShowUpdate(false);
      setChecking(false);
      setTimeout(() => window.location.reload(), 500);
    } else {
      setShowUpdate(false);
      setChecking(false);
      (async () => {
        try {
          // Unregister all service workers
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
          // Clear all caches (SW + runtime)
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        } catch { /* best effort */ }
        // Hard reload with cache bust — critical for mobile PWA
        // which may serve stale HTML from browser HTTP cache
        const url = new URL(window.location.href);
        url.searchParams.set('_cb', Date.now());
        window.location.replace(url.href);
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
            {newVersion ? `Update to ${newVersion}` : 'New version available'}
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
