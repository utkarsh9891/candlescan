import { useEffect, useState } from 'react';

/**
 * Index picker for the Single Ticker Widget.
 *
 * Persists the chosen TV symbol under `candlescan_single_ticker_symbol`
 * in localStorage (default `NSE:NIFTY`). Exposes a `<select>` with a
 * short list of popular Indian indices mapped to their TradingView
 * symbols.
 *
 * Props:
 *   value     — current TV symbol (controlled).
 *   onChange  — (symbol: string) => void. Fired when the user picks.
 *   inline    — when true, renders just the <select> (no label + card);
 *               useful when embedded inside Settings.
 */

export const SINGLE_TICKER_LS_KEY = 'candlescan_single_ticker_symbol';
export const DEFAULT_SINGLE_TICKER_SYMBOL = 'NSE:NIFTY';

/**
 * Popular index → TradingView symbol map.
 * Symbols follow TV's `NSE:<TICKER>` convention as used on
 * https://www.tradingview.com/symbols/<SYMBOL>/ — these are the
 * canonical codes for the NSE index family.
 */
export const TICKER_OPTIONS = [
  { label: 'NIFTY 50', symbol: 'NSE:NIFTY' },
  { label: 'NIFTY BANK', symbol: 'NSE:BANKNIFTY' },
  { label: 'NIFTY IT', symbol: 'NSE:CNXIT' },
  { label: 'NIFTY MIDCAP 100', symbol: 'NSE:CNXMIDCAP' },
  { label: 'NIFTY SMALLCAP 100', symbol: 'NSE:CNXSMALLCAP' },
  { label: 'INDIA VIX', symbol: 'NSE:INDIAVIX' },
];

/** Read the persisted TV symbol, or the default. */
export function readSavedTickerSymbol() {
  try {
    const v = localStorage.getItem(SINGLE_TICKER_LS_KEY);
    return v && typeof v === 'string' ? v : DEFAULT_SINGLE_TICKER_SYMBOL;
  } catch {
    return DEFAULT_SINGLE_TICKER_SYMBOL;
  }
}

/** Write the TV symbol to localStorage (best-effort). */
export function writeTickerSymbol(symbol) {
  try { localStorage.setItem(SINGLE_TICKER_LS_KEY, symbol); } catch { /* quota */ }
}

export default function SingleTickerPicker({ value, onChange, inline = false }) {
  // Controlled-ish: if caller passes value, mirror it; otherwise fall back to LS.
  const [local, setLocal] = useState(() => value || readSavedTickerSymbol());

  useEffect(() => {
    if (value && value !== local) setLocal(value);
  }, [value, local]);

  const handleChange = (e) => {
    const next = e.target.value;
    setLocal(next);
    writeTickerSymbol(next);
    if (onChange) onChange(next);
  };

  const selectEl = (
    <select
      value={local}
      onChange={handleChange}
      aria-label="Market ticker index"
      data-testid="single-ticker-picker"
      style={{
        padding: '6px 10px',
        fontSize: 12,
        fontWeight: 600,
        border: '1px solid #e2e5eb',
        borderRadius: 6,
        background: '#fff',
        color: '#4a5068',
        cursor: 'pointer',
        outline: 'none',
      }}
    >
      {TICKER_OPTIONS.map((o) => (
        <option key={o.symbol} value={o.symbol}>{o.label}</option>
      ))}
    </select>
  );

  if (inline) return selectEl;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 13, color: '#4a5068' }}>Ticker index</span>
      {selectEl}
    </div>
  );
}
