// @vitest-environment jsdom
//
// Smoke test for useIndexUniverse — focus on the localStorage-cache
// stale-fallback wiring added for Phase 2 rate-limit hardening.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';

// Mock fetchNseIndexWithNames so tests don't hit the network. Each test
// overrides the implementation with mockImplementationOnce / mockResolvedValue.
const fetchMock = vi.fn();
vi.mock('../engine/nseIndexFetch.js', () => ({
  fetchNseIndexWithNames: (...args) => fetchMock(...args),
}));

// Dynamic-index classifier — keep the static path for these tests by
// always returning false.
vi.mock('../data/dynamicIndices.js', () => ({
  isDynamicIndex: () => false,
}));

// Import after the mocks are registered.
import { useIndexUniverse } from './useIndexUniverse.js';
import {
  setCachedIndexSymbols,
  clearAllIndexCaches,
  NSE_INDEX_CACHE_PREFIX,
} from '../engine/nseIndexCache.js';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  fetchMock.mockReset();
  // Silence expected console warnings from stale-fallback
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useIndexUniverse — localStorage cache wiring', () => {
  it('writes localStorage when the fresh fetch succeeds', async () => {
    // Pick a default that matches DEFAULT_NSE_INDEX_ID ("NIFTY 200")
    fetchMock.mockResolvedValue({
      symbols: ['RELIANCE', 'TCS'],
      companyMap: { RELIANCE: 'Reliance Industries' },
    });

    const { result } = renderHook(() => useIndexUniverse());

    await waitFor(() => {
      expect(result.current.constituents.length).toBeGreaterThan(0);
    });
    expect(result.current.constituents).toEqual(['RELIANCE', 'TCS']);
    // localStorage should now carry the cached entry for the default index.
    const raw = localStorage.getItem(`${NSE_INDEX_CACHE_PREFIX}NIFTY 200`);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw);
    expect(parsed.symbols).toEqual(['RELIANCE', 'TCS']);
    expect(typeof parsed.fetchedAt).toBe('number');
    expect(parsed.expiresAt).toBeGreaterThan(parsed.fetchedAt);
  });

  it('uses stale localStorage cache when the network fetch fails', async () => {
    // Pre-populate a fresh cache so the FIRST read path doesn't even call
    // fetchNseIndexWithNames. To force a network attempt, expire the entry
    // manually and fall into getStaleIndexSymbols.
    setCachedIndexSymbols('NIFTY 200', ['STALE_SYM_1', 'STALE_SYM_2'], { ttlMs: 1 });
    // Wait past TTL (1 ms).
    await new Promise((r) => setTimeout(r, 5));

    // Network is down.
    fetchMock.mockRejectedValue(new Error('503'));

    const { result } = renderHook(() => useIndexUniverse());

    // Stale symbols should appear; no error surfaced.
    await waitFor(() => {
      expect(result.current.constituents).toEqual(['STALE_SYM_1', 'STALE_SYM_2']);
    });
    expect(result.current.constituentsError).toBe('');
    expect(result.current.constituentsLoading).toBe(false);
    // And the warning was emitted.
    // eslint-disable-next-line no-console
    expect(console.warn).toHaveBeenCalled();
  });

  it('surfaces an error when both fresh fetch AND stale cache are missing', async () => {
    fetchMock.mockRejectedValue(new Error('NSE ded'));

    const { result } = renderHook(() => useIndexUniverse());

    await waitFor(() => {
      expect(result.current.constituentsError).toMatch(/NSE ded|Could not load/);
    });
    expect(result.current.constituents).toEqual([]);
  });

  it('serves fresh localStorage cache without hitting the network for the selected index', async () => {
    setCachedIndexSymbols('NIFTY 200', ['CACHED_A', 'CACHED_B']);
    // The hook also pre-fetches NIFTY TOTAL MARKET for the broad search
    // universe; stub it out so we can assert the selected-index path did
    // not re-hit the network.
    fetchMock.mockImplementation((idx) => {
      if (idx === 'NIFTY TOTAL MARKET') {
        return Promise.resolve({ symbols: ['ANY'], companyMap: {} });
      }
      return Promise.reject(new Error('should have been served from cache'));
    });

    const { result } = renderHook(() => useIndexUniverse());

    await waitFor(() => {
      expect(result.current.constituents).toEqual(['CACHED_A', 'CACHED_B']);
    });
    expect(result.current.constituentsError).toBe('');
    // No call should have targeted "NIFTY 200" — only the broad universe
    // pre-fetch is permitted.
    const calledFor = fetchMock.mock.calls.map((c) => c[0]);
    expect(calledFor).not.toContain('NIFTY 200');
  });
});

// Safety net: make sure our test-side clearAll helper is exported and callable.
describe('clearAllIndexCaches (exported sanity)', () => {
  it('removes every candlescan_nse_index:* key', () => {
    setCachedIndexSymbols('NIFTY 200', ['A']);
    setCachedIndexSymbols('NIFTY 50', ['B']);
    localStorage.setItem('unrelated', '1');
    act(() => { clearAllIndexCaches(); });
    expect(localStorage.getItem(`${NSE_INDEX_CACHE_PREFIX}NIFTY 200`)).toBeNull();
    expect(localStorage.getItem(`${NSE_INDEX_CACHE_PREFIX}NIFTY 50`)).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('1');
  });
});
