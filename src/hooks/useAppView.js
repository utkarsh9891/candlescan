/**
 * useAppView — owns the top-level view routing, back-button handling,
 * and the "where did I come from" flags (cameFromBatch,
 * cameFromSimulation, settingsReturnView).
 *
 * Extracted from src/App.jsx. Pure behaviour-preserving move:
 *   - Push/replaceState semantics unchanged
 *   - Double-back-to-exit timing unchanged
 *   - Auto-navigation to settings when returning from Zerodha OAuth
 *     is unchanged
 *
 * View values: 'main' | 'batch' | 'simulate' | 'paper' | 'novice' | 'settings'
 */

import { useState, useEffect, useRef, useCallback } from 'react';

export function useAppView() {
  const [view, setViewRaw] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('request_token') && params.get('action') === 'login') return 'settings';
    return 'main';
  });
  const [cameFromBatch, setCameFromBatch] = useState(false);
  const [cameFromSimulation, setCameFromSimulation] = useState(false);
  const [settingsReturnView, setSettingsReturnView] = useState('main');

  const lastBackTime = useRef(0);
  const viewRef = useRef('main');

  // Simple navigation: back always goes to home, double-back exits app.
  // No history stack — replaceState, not pushState.
  const setView = useCallback((newView) => {
    viewRef.current = newView;
    setViewRaw(newView);
    if (newView !== 'main') {
      window.history.pushState({ view: 'non-main' }, '', '');
    }
  }, []);

  useEffect(() => {
    window.history.replaceState({ view: 'main' }, '', '');

    const onPopState = () => {
      if (viewRef.current !== 'main') {
        viewRef.current = 'main';
        setViewRaw('main');
        setCameFromBatch(false);
        setCameFromSimulation(false);
        window.history.replaceState({ view: 'main' }, '', '');
      } else {
        const now = Date.now();
        if (now - lastBackTime.current < 2000) {
          window.history.back();
          return;
        }
        lastBackTime.current = now;
        window.history.pushState({ view: 'home-guard' }, '', '');
      }
    };

    window.history.pushState({ view: 'home-guard' }, '', '');
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return {
    view, setView,
    cameFromBatch, setCameFromBatch,
    cameFromSimulation, setCameFromSimulation,
    settingsReturnView, setSettingsReturnView,
  };
}
