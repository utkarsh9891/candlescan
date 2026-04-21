/**
 * useIndexUniverse — owns the NSE index constituents, the broad
 * NIFTY TOTAL MARKET search universe, custom indices, and the
 * session-cache that keeps them from re-fetching on every view
 * switch.
 *
 * Extracted from src/App.jsx during the file-size refactor. Pure
 * behaviour-preserving move — logic is unchanged, only the location.
 *
 * Returns the currently-selected `nseIndex`, its symbol list +
 * company map, a broad search universe (NIFTY TOTAL MARKET symbols),
 * custom indices with add/remove helpers, and the plumbing needed
 * for the sidebar modal (error, loading, refresh). The App consumes
 * these as plain values and wires them to the IndexConstituentsSidebar
 * and the SearchBar's symbols/company map inputs.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  DEFAULT_NSE_INDEX_ID,
  getCustomIndices,
  addCustomIndex,
  removeCustomIndex,
  getAllIndexOptions,
  getBuiltInIndexOptions,
} from '../config/nseIndices.js';
import { fetchNseIndexWithNames } from '../engine/nseIndexFetch.js';
import { isDynamicIndex } from '../data/dynamicIndices.js';
import {
  getCachedIndexSymbols,
  setCachedIndexSymbols,
  getStaleIndexSymbols,
  BACKGROUND_REFRESH_AGE_MS,
} from '../engine/nseIndexCache.js';

const NSE_SYM_CACHE_PREFIX = 'candlescan_nse_syms_v1_';
const NSE_SYM_CACHE_MS = 45 * 60 * 1000;
const SEARCH_UNIVERSE_KEY = '__SEARCH_UNIVERSE__';

function readNseSymsCache(indexId) {
  try {
    const raw = sessionStorage.getItem(NSE_SYM_CACHE_PREFIX + indexId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const { t, syms, companyMap: cm } = parsed;
    if (!Array.isArray(syms) || Date.now() - t > NSE_SYM_CACHE_MS) return null;
    return { syms, companyMap: cm || {} };
  } catch {
    return null;
  }
}

function writeNseSymsCache(indexId, syms, companyMap) {
  try {
    sessionStorage.setItem(NSE_SYM_CACHE_PREFIX + indexId, JSON.stringify({ t: Date.now(), syms, companyMap }));
  } catch {
    /* quota */
  }
}

export function useIndexUniverse() {
  const [nseIndex, setNseIndex] = useState(() => {
    try {
      const s = localStorage.getItem('candlescan_nse_index');
      if (s && getAllIndexOptions().some((o) => o.id === s)) return s;
    } catch {
      /* ignore */
    }
    return DEFAULT_NSE_INDEX_ID;
  });

  const [customIndices, setCustomIndices] = useState(() => getCustomIndices());
  // getBuiltInIndexOptions() refreshes live labels (Top Gainers/Losers) each render
  const allIndexOptions = [...getBuiltInIndexOptions(), ...customIndices];

  const handleAddCustomIndex = useCallback((id) => {
    const updated = addCustomIndex(id);
    setCustomIndices(updated);
  }, []);

  const handleRemoveCustomIndex = useCallback((id) => {
    const updated = removeCustomIndex(id);
    setCustomIndices(updated);
    setNseIndex((prev) => (prev === id ? DEFAULT_NSE_INDEX_ID : prev));
  }, []);

  const [constituents, setConstituents] = useState([]);
  const [constituentsLoading, setConstituentsLoading] = useState(false);
  const [constituentsError, setConstituentsError] = useState('');
  const [companyMap, setCompanyMap] = useState({});
  const [broadSearchSymbols, setBroadSearchSymbols] = useState([]);
  const [broadCompanyMap, setBroadCompanyMap] = useState({});
  const [refreshKey, setRefreshKey] = useState(0);

  // Persist the selected index
  useEffect(() => {
    try {
      localStorage.setItem('candlescan_nse_index', nseIndex);
    } catch {
      /* quota */
    }
  }, [nseIndex]);

  // Pre-fetch NIFTY TOTAL MARKET (~750 stocks) for the broad search universe
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = readNseSymsCache(SEARCH_UNIVERSE_KEY);
      if (cached?.syms?.length) {
        setBroadSearchSymbols(cached.syms);
        setBroadCompanyMap(cached.companyMap || {});
        return;
      }
      try {
        const result = await fetchNseIndexWithNames('NIFTY TOTAL MARKET');
        if (!cancelled && result.symbols.length) {
          setBroadSearchSymbols(result.symbols);
          setBroadCompanyMap(result.companyMap || {});
          writeNseSymsCache(SEARCH_UNIVERSE_KEY, result.symbols, result.companyMap);
        }
      } catch { /* silent — fallback to current index */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Fetch constituents whenever the selected index or refreshKey changes.
  //
  // Read precedence (static indices only — dynamic movers always hit network):
  //   1. Session cache (45 min) — avoids re-fetch on view switches in the tab.
  //   2. LocalStorage cache (7 days) — survives reloads and offline. If the
  //      entry is still fresh but older than BACKGROUND_REFRESH_AGE_MS we
  //      still use it immediately and kick off a silent refresh behind it.
  //   3. Network (Worker proxy / fallbacks).
  //   4. Stale localStorage fallback — if the network fetch fails we'd
  //      rather show yesterday's (or last week's) symbols than an empty
  //      scan. NSE index membership is very stable day-to-day.
  useEffect(() => {
    let cancelled = false;
    const refreshInBackground = async () => {
      try {
        const result = await fetchNseIndexWithNames(nseIndex);
        if (cancelled || !result.symbols.length) return;
        setConstituents(result.symbols);
        setCompanyMap(result.companyMap || {});
        writeNseSymsCache(nseIndex, result.symbols, result.companyMap);
        setCachedIndexSymbols(nseIndex, result.symbols);
      } catch {
        /* background refresh is best-effort — the cached data is still good */
      }
    };

    (async () => {
      if (!isDynamicIndex(nseIndex)) {
        // 1) Session cache — hot path
        const cached = readNseSymsCache(nseIndex);
        if (cached?.syms?.length) {
          setConstituents(cached.syms);
          setCompanyMap(cached.companyMap || {});
          setConstituentsError('');
          setConstituentsLoading(false);
          return;
        }
        // 2) LocalStorage cache (7d) — survives reloads
        const ls = getCachedIndexSymbols(nseIndex);
        if (ls?.symbols?.length) {
          setConstituents(ls.symbols);
          setCompanyMap({}); // LS cache is symbols-only; names load on next fresh fetch
          setConstituentsError('');
          setConstituentsLoading(false);
          // Stale-within-TTL: use immediately, refresh silently
          const age = Date.now() - ls.fetchedAt;
          if (age > BACKGROUND_REFRESH_AGE_MS) {
            refreshInBackground();
          }
          return;
        }
      }
      const isAutoRefresh = isDynamicIndex(nseIndex) && constituents.length > 0;
      if (!isAutoRefresh) {
        setConstituentsLoading(true);
        setConstituentsError('');
        setConstituents([]);
      }
      try {
        const result = await fetchNseIndexWithNames(nseIndex);
        if (!cancelled) {
          setConstituents(result.symbols);
          setCompanyMap(result.companyMap || {});
          writeNseSymsCache(nseIndex, result.symbols, result.companyMap);
          if (!isDynamicIndex(nseIndex) && result.symbols.length) {
            setCachedIndexSymbols(nseIndex, result.symbols);
          }
        }
      } catch (e) {
        if (cancelled) return;
        // Graceful degradation — try the expired localStorage entry before
        // surfacing an empty view to the user. NSE's API flakes often; a
        // day-old symbol list is almost always still correct.
        if (!isDynamicIndex(nseIndex)) {
          const stale = getStaleIndexSymbols(nseIndex);
          if (stale?.symbols?.length) {
            // eslint-disable-next-line no-console
            console.warn(
              `[useIndexUniverse] NSE fetch for "${nseIndex}" failed; using stale cache from ${new Date(stale.fetchedAt).toISOString()}`,
            );
            setConstituents(stale.symbols);
            setCompanyMap({});
            setConstituentsError('');
            return;
          }
        }
        setConstituentsError(e?.message || 'Could not load NSE index.');
        setConstituents([]);
      } finally {
        if (!cancelled) setConstituentsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // constituents.length intentionally omitted — it's only referenced to
    // detect the auto-refresh case, and re-running on its change would loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nseIndex, refreshKey]);

  // Auto-refresh dynamic indices (Top Gainers/Losers) every 30 seconds
  useEffect(() => {
    if (!isDynamicIndex(nseIndex)) return;
    const interval = setInterval(() => setRefreshKey(k => k + 1), 30000);
    return () => clearInterval(interval);
  }, [nseIndex]);

  return {
    nseIndex, setNseIndex,
    customIndices, allIndexOptions,
    handleAddCustomIndex, handleRemoveCustomIndex,
    constituents, constituentsLoading, constituentsError,
    companyMap,
    broadSearchSymbols, setBroadSearchSymbols,
    broadCompanyMap, setBroadCompanyMap,
    refreshIndex: useCallback(() => setRefreshKey(k => k + 1), []),
  };
}
