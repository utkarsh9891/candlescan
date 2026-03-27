/**
 * NSE public index constituents API (browser via proxy / worker).
 * @see https://www.nseindia.com/api/equity-stockIndices?index=...
 */

export const NSE_EQUITY_INDICES_BASE = 'https://www.nseindia.com/api/equity-stockIndices';

/** `index` query values exactly as NSE expects (space-separated names). */
export const NSE_INDEX_OPTIONS = [
  { id: 'NIFTY 50', label: 'NIFTY 50' },
  { id: 'NIFTY NEXT 50', label: 'NIFTY NEXT 50' },
  { id: 'NIFTY 100', label: 'NIFTY 100' },
  { id: 'NIFTY MIDCAP 50', label: 'NIFTY MIDCAP 50' },
  { id: 'NIFTY MIDCAP 100', label: 'NIFTY MIDCAP 100' },
  { id: 'NIFTY SMALLCAP 100', label: 'NIFTY SMALLCAP 100' },
  { id: 'NIFTY 200', label: 'NIFTY 200' },
  { id: 'NIFTY 500', label: 'NIFTY 500' },
  { id: 'NIFTY MIDCAP 150', label: 'NIFTY MIDCAP 150' },
  { id: 'NIFTY SMALLCAP 250', label: 'NIFTY SMALLCAP 250' },
];

export const DEFAULT_NSE_INDEX_ID = 'NIFTY 200';
