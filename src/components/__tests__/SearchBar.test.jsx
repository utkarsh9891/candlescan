// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import SearchBar from '../SearchBar.jsx';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SYMBOLS = ['RELIANCE', 'RELIANCEINFRA', 'TCS', 'INFY', 'HDFCBANK'];
const COMPANY_MAP = {
  RELIANCE: 'Reliance Industries Ltd',
  RELIANCEINFRA: 'Reliance Infra Ltd',
  TCS: 'Tata Consultancy Services',
  INFY: 'Infosys Ltd',
  HDFCBANK: 'HDFC Bank Ltd',
};

function renderSearchBar(overrides = {}) {
  const props = {
    inputVal: '',
    setInputVal: vi.fn(),
    onScan: vi.fn(),
    loading: false,
    onOpenStockList: vi.fn(),
    universeLabel: 'NIFTY 50',
    symbols: SYMBOLS,
    companyMap: COMPANY_MAP,
    ...overrides,
  };
  const result = render(<SearchBar {...props} />);
  return { ...result, props };
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SearchBar', () => {
  it('renders the input and scan button', () => {
    renderSearchBar();
    expect(screen.getByPlaceholderText(/search symbol/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /scan/i })).toBeInTheDocument();
  });

  it('calls setInputVal on typing', () => {
    const setInputVal = vi.fn();
    renderSearchBar({ setInputVal });

    const input = screen.getByPlaceholderText(/search symbol/i);
    fireEvent.change(input, { target: { value: 'TCS' } });
    expect(setInputVal).toHaveBeenCalledWith('TCS');
  });

  it('shows dropdown when focused and input has 2+ chars matching symbols', () => {
    renderSearchBar({ inputVal: 'RE' });

    const input = screen.getByPlaceholderText(/search symbol/i);
    fireEvent.focus(input);

    // Should show matching suggestions
    expect(screen.getByText('RELIANCE')).toBeInTheDocument();
    expect(screen.getByText('RELIANCEINFRA')).toBeInTheDocument();
  });

  it('does not show dropdown for very short input', () => {
    renderSearchBar({ inputVal: 'R' });

    const input = screen.getByPlaceholderText(/search symbol/i);
    fireEvent.focus(input);

    // Should NOT show suggestions (min 2 chars)
    expect(screen.queryByText('RELIANCE')).not.toBeInTheDocument();
  });

  it('selecting a dropdown item calls onScan with the correct symbol', async () => {
    const onScan = vi.fn();
    const setInputVal = vi.fn();
    renderSearchBar({ inputVal: 'RE', onScan, setInputVal });

    const input = screen.getByPlaceholderText(/search symbol/i);
    fireEvent.focus(input);

    // Find the RELIANCE button in the dropdown and pointerDown on it
    const item = screen.getByText('RELIANCE');
    const btn = item.closest('button');
    fireEvent.pointerDown(btn);

    // setInputVal should be called with the symbol
    expect(setInputVal).toHaveBeenCalledWith('RELIANCE');

    // onScan is called via setTimeout(, 0) — wait for it
    await waitFor(() => {
      expect(onScan).toHaveBeenCalledWith('RELIANCE');
    });
  });

  it('closes dropdown immediately after selection (click guard blocks pass-through)', () => {
    const onScan = vi.fn();
    const setInputVal = vi.fn();
    renderSearchBar({ inputVal: 'RE', onScan, setInputVal });

    const input = screen.getByPlaceholderText(/search symbol/i);
    fireEvent.focus(input);

    // Dropdown should be visible
    const item = screen.getByText('RELIANCE');
    expect(item).toBeVisible();

    // Select the item via pointerDown
    const btn = item.closest('button');
    fireEvent.pointerDown(btn);

    // Dropdown should be closed immediately (focused = false)
    expect(screen.queryByText('Reliance Industries Ltd')).not.toBeInTheDocument();

    // setInputVal should have been called
    expect(setInputVal).toHaveBeenCalledWith('RELIANCE');
  });

  describe('keyboard navigation', () => {
    it('ArrowDown moves selection down', () => {
      renderSearchBar({ inputVal: 'RE' });

      const input = screen.getByPlaceholderText(/search symbol/i);
      fireEvent.focus(input);

      // Initially no selection (selectedIdx = -1)
      // Press ArrowDown to select first item
      fireEvent.keyDown(input, { key: 'ArrowDown' });

      // The first item should get highlighted background
      const buttons = screen.getAllByRole('button').filter(
        (b) => b.textContent.includes('RELIANCE') && !b.textContent.includes('Scan')
      );
      // First dropdown button should have the selected background
      expect(buttons[0].style.background).toBe('rgb(239, 246, 255)');
    });

    it('ArrowUp moves selection up', () => {
      renderSearchBar({ inputVal: 'RE' });

      const input = screen.getByPlaceholderText(/search symbol/i);
      fireEvent.focus(input);

      // Move down twice, then up once
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'ArrowUp' });

      // First item should be selected
      const buttons = screen.getAllByRole('button').filter(
        (b) => b.textContent.includes('RELIANCE') && !b.textContent.includes('Scan') && !b.textContent.includes('RELIANCEINFRA')
      );
      expect(buttons[0].style.background).toBe('rgb(239, 246, 255)');
    });

    it('Enter on a selected suggestion calls onScan with that symbol', async () => {
      const onScan = vi.fn();
      const setInputVal = vi.fn();
      renderSearchBar({ inputVal: 'RE', onScan, setInputVal });

      const input = screen.getByPlaceholderText(/search symbol/i);
      fireEvent.focus(input);

      // Select first item with ArrowDown
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      // Press Enter
      fireEvent.keyDown(input, { key: 'Enter' });

      // Should call onScan with the first suggestion (RELIANCE)
      await waitFor(() => {
        expect(onScan).toHaveBeenCalledWith('RELIANCE');
      });
    });

    it('Enter without selection calls onScan with no args', () => {
      const onScan = vi.fn();
      renderSearchBar({ inputVal: 'RE', onScan });

      const input = screen.getByPlaceholderText(/search symbol/i);
      fireEvent.focus(input);

      // Press Enter without selecting any item (selectedIdx = -1)
      fireEvent.keyDown(input, { key: 'Enter' });

      // onScan called without arguments (user typed symbol, wants to scan that)
      expect(onScan).toHaveBeenCalledWith();
    });

    it('Escape closes the dropdown', () => {
      renderSearchBar({ inputVal: 'RE' });

      const input = screen.getByPlaceholderText(/search symbol/i);
      fireEvent.focus(input);

      // Dropdown visible
      expect(screen.getByText('RELIANCE')).toBeInTheDocument();

      // Press Escape
      fireEvent.keyDown(input, { key: 'Escape' });

      // Dropdown should close (focused = false)
      expect(screen.queryByText('Reliance Industries Ltd')).not.toBeInTheDocument();
    });

    it('Enter with no dropdown calls onScan', () => {
      const onScan = vi.fn();
      renderSearchBar({ inputVal: 'X', onScan }); // 'X' is < 2 chars, no dropdown

      const input = screen.getByPlaceholderText(/search symbol/i);
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onScan).toHaveBeenCalledWith();
    });
  });

  it('shows the Browse universe link', () => {
    renderSearchBar({ universeLabel: 'NIFTY 50' });
    expect(screen.getByText(/browse nifty 50/i)).toBeInTheDocument();
  });

  it('disables scan button when loading', () => {
    renderSearchBar({ loading: true });
    const btn = screen.getByRole('button', { name: /…/ });
    expect(btn).toBeDisabled();
  });
});
