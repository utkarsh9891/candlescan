// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import SingleTickerWidget from '../SingleTickerWidget.jsx';
import SingleTickerPicker, {
  SINGLE_TICKER_LS_KEY,
  DEFAULT_SINGLE_TICKER_SYMBOL,
  readSavedTickerSymbol,
  writeTickerSymbol,
  TICKER_OPTIONS,
} from '../SingleTickerPicker.jsx';

afterEach(() => {
  cleanup();
  try { localStorage.clear(); } catch { /* ok */ }
});

describe('SingleTickerWidget', () => {
  it('renders a region with the symbol in its aria-label', () => {
    render(<SingleTickerWidget symbol="NSE:NIFTY" />);
    const el = screen.getByTestId('single-ticker-widget');
    expect(el).toBeTruthy();
    expect(el.getAttribute('role')).toBe('region');
    expect(el.getAttribute('aria-label')).toMatch(/NSE:NIFTY/);
    expect(el.getAttribute('data-symbol')).toBe('NSE:NIFTY');
  });

  it('injects the TradingView widget container + script into the DOM', () => {
    render(<SingleTickerWidget symbol="NSE:BANKNIFTY" />);
    const el = screen.getByTestId('single-ticker-widget');
    // TV widget __widget div is nested inside
    expect(el.querySelector('.tradingview-widget-container__widget')).toBeTruthy();
    const script = el.querySelector('script');
    expect(script).toBeTruthy();
    expect(script.src).toContain('embed-widget-single-quote.js');
    // Config JSON embedded in the script's inner text
    expect(script.innerHTML).toContain('NSE:BANKNIFTY');
  });

  it('defaults to NSE:NIFTY when no symbol prop is given', () => {
    render(<SingleTickerWidget />);
    const el = screen.getByTestId('single-ticker-widget');
    expect(el.getAttribute('data-symbol')).toBe('NSE:NIFTY');
  });

  it('respects custom height', () => {
    render(<SingleTickerWidget symbol="NSE:NIFTY" height={60} />);
    const el = screen.getByTestId('single-ticker-widget');
    expect(el.style.height).toBe('60px');
  });
});

describe('SingleTickerPicker', () => {
  it('exports default symbol as NSE:NIFTY and a stable LS key', () => {
    expect(DEFAULT_SINGLE_TICKER_SYMBOL).toBe('NSE:NIFTY');
    expect(SINGLE_TICKER_LS_KEY).toBe('candlescan_single_ticker_symbol');
  });

  it('readSavedTickerSymbol falls back to default when LS is empty', () => {
    expect(readSavedTickerSymbol()).toBe('NSE:NIFTY');
  });

  it('writeTickerSymbol persists to localStorage and readSavedTickerSymbol reads it', () => {
    writeTickerSymbol('NSE:BANKNIFTY');
    expect(localStorage.getItem(SINGLE_TICKER_LS_KEY)).toBe('NSE:BANKNIFTY');
    expect(readSavedTickerSymbol()).toBe('NSE:BANKNIFTY');
  });

  it('renders a select with all popular indices and fires onChange', () => {
    const onChange = vi.fn();
    render(<SingleTickerPicker value="NSE:NIFTY" onChange={onChange} />);
    const select = screen.getByTestId('single-ticker-picker');
    expect(select.tagName).toBe('SELECT');
    expect(select.querySelectorAll('option').length).toBe(TICKER_OPTIONS.length);

    fireEvent.change(select, { target: { value: 'NSE:BANKNIFTY' } });
    expect(onChange).toHaveBeenCalledWith('NSE:BANKNIFTY');
    // Side-effect: persisted to LS
    expect(localStorage.getItem(SINGLE_TICKER_LS_KEY)).toBe('NSE:BANKNIFTY');
  });
});
