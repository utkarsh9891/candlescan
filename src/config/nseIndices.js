/**
 * NSE public index constituents API (browser via proxy / worker).
 * @see https://www.nseindia.com/api/equity-stockIndices?index=...
 */

export const NSE_EQUITY_INDICES_BASE = 'https://www.nseindia.com/api/equity-stockIndices';

/** `index` query values exactly as NSE expects (space-separated names). */
export const NSE_INDEX_OPTIONS = [
  // Dynamic — live market movers (fetched from NSE live-analysis API)
  { id: 'TOP GAINERS (Live)', label: 'TOP GAINERS (Live)', dynamic: true },
  { id: 'TOP LOSERS (Live)', label: 'TOP LOSERS (Live)', dynamic: true },
  // 50 — large, mid, small
  { id: 'NIFTY 50', label: 'NIFTY 50' },
  { id: 'NIFTY MIDCAP 50', label: 'NIFTY MIDCAP 50' },
  { id: 'NIFTY SMALLCAP 50', label: 'NIFTY SMALLCAP 50' },
  // 100 — large, mid, small
  { id: 'NIFTY 100', label: 'NIFTY 100' },
  { id: 'NIFTY MIDCAP 100', label: 'NIFTY MIDCAP 100' },
  { id: 'NIFTY SMALLCAP 100', label: 'NIFTY SMALLCAP 100' },
  // Full segment — large+mid broad, full midcap, full smallcap
  { id: 'NIFTY 200', label: 'NIFTY 200' },
  { id: 'NIFTY MIDCAP 150', label: 'NIFTY MIDCAP 150' },
  { id: 'NIFTY SMALLCAP 250', label: 'NIFTY SMALLCAP 250' },
];

export const DEFAULT_NSE_INDEX_ID = 'NIFTY 200';

const CUSTOM_INDICES_KEY = 'candlescan_custom_indices';

/** Read custom indices from localStorage. */
export function getCustomIndices() {
  try {
    const raw = localStorage.getItem(CUSTOM_INDICES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Add a custom index (id = exact NSE API name). Returns updated list. */
export function addCustomIndex(id) {
  const existing = getCustomIndices();
  const normalized = id.trim().toUpperCase();
  // Skip if already in built-in or custom list
  if (NSE_INDEX_OPTIONS.some((o) => o.id === normalized)) return existing;
  if (existing.some((o) => o.id === normalized)) return existing;
  const updated = [...existing, { id: normalized, label: `${normalized} (custom)` }];
  try { localStorage.setItem(CUSTOM_INDICES_KEY, JSON.stringify(updated)); } catch { /* quota */ }
  return updated;
}

/** Remove a custom index by id. Returns updated list. */
export function removeCustomIndex(id) {
  const updated = getCustomIndices().filter((o) => o.id !== id);
  try { localStorage.setItem(CUSTOM_INDICES_KEY, JSON.stringify(updated)); } catch { /* quota */ }
  return updated;
}

/** Built-in + custom indices merged. */
export function getAllIndexOptions() {
  return [...NSE_INDEX_OPTIONS, ...getCustomIndices()];
}
