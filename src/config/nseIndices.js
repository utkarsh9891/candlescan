/**
 * NSE public index constituents API (browser via proxy / worker).
 * @see https://www.nseindia.com/api/equity-stockIndices?index=...
 */

export const NSE_EQUITY_INDICES_BASE = 'https://www.nseindia.com/api/equity-stockIndices';

/**
 * True when NSE is currently in session: Mon-Fri, 09:15-15:30 IST.
 * Note: does not account for NSE holidays (minor inaccuracy, acceptable).
 * Works regardless of the browser's local timezone.
 */
export function isMarketOpen(now = new Date()) {
  // now.getTime() is always UTC ms. Add 5.5h offset to get IST wall-clock.
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const day = ist.getUTCDay(); // 0 Sun .. 6 Sat
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

/** Dynamic label suffix for Top Gainers/Losers based on market state. */
function dynamicLabel(base) {
  return isMarketOpen() ? `${base} (Live)` : `${base} (Last Session)`;
}

/** `index` query values exactly as NSE expects (space-separated names). */
export const NSE_INDEX_OPTIONS = [
  // Dynamic — live market movers (fetched from NSE live-analysis API).
  // The ID stays constant; the displayed label is computed dynamically
  // by getAllIndexOptions() below so it reflects current market state.
  { id: 'TOP GAINERS (Live)', label: 'TOP GAINERS (Live)', dynamic: true },
  { id: 'TOP LOSERS (Live)', label: 'TOP LOSERS (Live)', dynamic: true },
  // Full segment — broadest to narrowest
  { id: 'NIFTY 200', label: 'NIFTY 200' },
  { id: 'NIFTY MIDCAP 150', label: 'NIFTY MIDCAP 150' },
  { id: 'NIFTY SMALLCAP 250', label: 'NIFTY SMALLCAP 250' },
  // 100 — nifty, mid, small
  { id: 'NIFTY 100', label: 'NIFTY 100' },
  { id: 'NIFTY MIDCAP 100', label: 'NIFTY MIDCAP 100' },
  { id: 'NIFTY SMALLCAP 100', label: 'NIFTY SMALLCAP 100' },
  // 50 — nifty, mid, small
  { id: 'NIFTY 50', label: 'NIFTY 50' },
  { id: 'NIFTY MIDCAP 50', label: 'NIFTY MIDCAP 50' },
  { id: 'NIFTY SMALLCAP 50', label: 'NIFTY SMALLCAP 50' },
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

/** Built-in index options with dynamic labels for Top Gainers/Losers. */
export function getBuiltInIndexOptions() {
  return NSE_INDEX_OPTIONS.map((o) => {
    if (o.id === 'TOP GAINERS (Live)') return { ...o, label: dynamicLabel('TOP GAINERS') };
    if (o.id === 'TOP LOSERS (Live)') return { ...o, label: dynamicLabel('TOP LOSERS') };
    return o;
  });
}

/** Built-in + custom indices merged, with dynamic labels for live movers. */
export function getAllIndexOptions() {
  return [...getBuiltInIndexOptions(), ...getCustomIndices()];
}
