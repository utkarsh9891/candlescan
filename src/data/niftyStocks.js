/**
 * @deprecated Static list removed — constituents come from NSE at runtime
 * (`fetchNseIndexSymbolList` + `NSE_INDEX_OPTIONS`).
 *
 * Scripts should use `scripts/lib/nse-http.mjs` with `--index`.
 */

export { NSE_INDEX_OPTIONS, DEFAULT_NSE_INDEX_ID, NSE_EQUITY_INDICES_BASE } from '../config/nseIndices.js';

/** @deprecated */
export default [];
