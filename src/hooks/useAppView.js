/**
 * useAppView — owns the top-level view routing, back-button handling,
 * and the "where did I come from" flag (cameFromBatch).
 *
 * Extracted from src/App.jsx. Pure behaviour-preserving move:
 *   - Push/replaceState semantics unchanged
 *   - Double-back-to-exit timing unchanged
 *   - Auto-navigation to settings when returning from Zerodha OAuth
 *     is unchanged
 *
 * View values: 'main' | 'batch' | 'paper' | 'novice' | 'settings'
 *
 * settingsReturnView — when the user opens Settings, we record which
 * tab they were on. Back from Settings (explicit button + hardware/
 * browser back) returns them to that tab, not the 'main' stock scanner.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

export function useAppView() {
  const [view, setViewRaw] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('request_token') && params.get('action') === 'login') return 'settings';
    return 'main';
  });
  const [cameFromBatch, setCameFromBatch] = useState(false);

  const lastBackTime = useRef(0);
  const viewRef = useRef('main');
  const settingsReturnRef = useRef('main');

  // Flat PWA-style navigation. Tabs and Settings are NOT separate
  // history entries — the app maintains exactly one "guard" entry on
  // the history stack at all times. Hardware/browser back triggers
  // popstate, which decides the destination based on in-memory view
  // state, then immediately re-pushes the guard so the next back
  // triggers popstate again instead of leaving the app unexpectedly.
  const setView = useCallback((newView) => {
    if (newView === 'settings' && viewRef.current !== 'settings') {
      settingsReturnRef.current = viewRef.current || 'main';
    }
    viewRef.current = newView;
    setViewRaw(newView);
  }, []);

  const backFromSettings = useCallback(() => {
    const target = settingsReturnRef.current || 'main';
    viewRef.current = target;
    setViewRaw(target);
  }, []);

  useEffect(() => {
    window.history.replaceState({ view: 'main' }, '', '');
    window.history.pushState({ view: 'home-guard' }, '', '');

    const onPopState = () => {
      // Back from Settings returns to the originating tab.
      if (viewRef.current === 'settings') {
        const target = settingsReturnRef.current || 'main';
        viewRef.current = target;
        setViewRaw(target);
        window.history.pushState({ view: 'home-guard' }, '', '');
        return;
      }
      // Back from any other non-main view goes home.
      if (viewRef.current !== 'main') {
        viewRef.current = 'main';
        setViewRaw('main');
        setCameFromBatch(false);
        window.history.pushState({ view: 'home-guard' }, '', '');
        return;
      }
      // Already at main: double-back within 2s exits the PWA.
      const now = Date.now();
      if (now - lastBackTime.current < 2000) {
        window.history.back();
        return;
      }
      lastBackTime.current = now;
      window.history.pushState({ view: 'home-guard' }, '', '');
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return {
    view, setView,
    cameFromBatch, setCameFromBatch,
    backFromSettings,
  };
}
