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

/** Returns true if `candidate` is strictly newer than `current` by semver.
 * Only strictly-greater triggers an update prompt — equal or older is a no-op.
 * Earlier logic matched any mismatch, which caused a persistent "Update to
 * v0.15.0" banner on devices already on v0.15.8 whenever LS_LATEST_VER was
 * stale-and-older than the running build (reported 2026-04-21). */
export function isNewer(candidate, current) {
  const pc = parseSemver(candidate);
  const pcur = parseSemver(current);
  if (!pc || !pcur) return false;
  if (pc[0] !== pcur[0]) return pc[0] > pcur[0];
  if (pc[1] !== pcur[1]) return pc[1] > pcur[1];
  return pc[2] > pcur[2];
}

/** Pick the highest-semver tag from a GitHub /releases response array.
 * The API sorts by creation time, not semver, so out-of-order publishes
 * (e.g. backfilled/edited releases) can put a lower version at index 0. */
export function pickLatestTag(releases) {
  if (!Array.isArray(releases) || releases.length === 0) return null;
  let best = null;
  let bestParsed = null;
  for (const r of releases) {
    const tag = r?.tag_name;
    const parsed = parseSemver(tag);
    if (!parsed) continue;
    if (
      !bestParsed ||
      parsed[0] > bestParsed[0] ||
      (parsed[0] === bestParsed[0] && parsed[1] > bestParsed[1]) ||
      (parsed[0] === bestParsed[0] && parsed[1] === bestParsed[1] && parsed[2] > bestParsed[2])
    ) {
      best = tag;
      bestParsed = parsed;
    }
  }
  return best;
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
  // Suppress update banner entirely in dev mode — the local git-describe
  // version is often stale vs deployed releases, causing a persistent banner
  // that can't actually update anything.
  const isDev = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV;

  // ── Passive SW detection (no extra network requests) ──────────────
  useEffect(() => {
    if (isDev) return; // no update checks in dev
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
      // Use /releases?per_page=5 (includes pre-releases) instead of
      // /releases/latest (which only returns full releases — 404 for 0.x.y).
      // per_page=5 so we can pick the semver-max, defending against
      // out-of-order publishes where the creation-time sort puts a
      // lower version at index 0.
      const ghUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=5`;
      let res;
      try {
        res = await fetch(ghUrl, { headers: { Accept: 'application/vnd.github+json' } });
      } catch {
        // Direct fetch failed (CORS/PNA on VPN networks) — route through CF worker
        res = await fetch(`${CF_WORKER_URL}/github/releases?repo=${GITHUB_REPO}`);
      }
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const data = await res.json();
      const latest = pickLatestTag(data);
      if (!latest) {
        // No parseable releases
        setChecking(false);
        try { localStorage.setItem(LS_LAST_CHECK, String(Date.now())); } catch { /* quota */ }
        return;
      }

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
    if (isDev) return; // no update checks in dev
    if (foundRef.current) return;
    try {
      // Reconcile stale cache: if the cached "latest" is equal-or-older than
      // the running build, it's a leftover from before the user updated.
      // Purge it so a later GH check (or a different device reading the
      // same account's cache) doesn't resurrect a downgrade banner.
      const cached = localStorage.getItem(LS_LATEST_VER);
      if (cached && !isNewer(cached, currentVersion)) {
        try { localStorage.removeItem(LS_LATEST_VER); } catch { /* quota */ }
      }

      const last = Number(localStorage.getItem(LS_LAST_CHECK) || '0');
      if (Date.now() - last < CHECK_INTERVAL_MS) {
        // Still within window — check cached result instead
        const freshCached = localStorage.getItem(LS_LATEST_VER);
        if (freshCached && isNewer(freshCached, currentVersion)) {
          setNewVersion(freshCached);
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

      {/* Update available banner — normal flow (not fixed) so it pushes
           the header down instead of covering the hamburger icon */}
      {showUpdate && (
        <div style={{
          padding: '10px 16px', background: '#2563eb', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontSize: 13, fontWeight: 600,
          boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
          margin: '-12px -12px 8px',
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
