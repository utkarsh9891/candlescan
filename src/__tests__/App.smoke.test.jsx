// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Mocks -- prevent real network calls and silence browser-only APIs
// ---------------------------------------------------------------------------

vi.mock('../engine/fetcher.js', () => ({
  fetchOHLCV: vi.fn().mockResolvedValue({ candles: [], error: 'mocked' }),
  CF_WORKER_URL: 'https://mock.test',
}));

vi.mock('../engine/nseIndexFetch.js', () => ({
  fetchNseIndexSymbolList: vi.fn().mockResolvedValue([]),
  fetchNseIndexWithNames: vi.fn().mockResolvedValue({ symbols: [], companyMap: {} }),
}));

vi.mock('../engine/yahooQuote.js', () => ({
  fetchYahooQuote: vi.fn().mockResolvedValue(null),
}));

vi.mock('../engine/zerodhaFetcher.js', () => ({
  fetchZerodhaOHLCV: vi.fn().mockResolvedValue({ candles: [], error: 'mocked' }),
}));

vi.mock('../engine/dhanFetcher.js', () => ({
  fetchDhanOHLCV: vi.fn().mockResolvedValue({ candles: [], error: 'mocked' }),
}));

vi.mock('../engine/indexDirection.js', () => ({
  getIndexDirection: vi.fn().mockResolvedValue(null),
}));

vi.mock('../utils/credentialVault.js', () => ({
  getVaultBlob: vi.fn().mockReturnValue(null),
  hasVault: vi.fn().mockReturnValue(false),
  clearVault: vi.fn(),
  unlockGate: vi.fn(),
  encryptToVault: vi.fn(),
  clearGate: vi.fn(),
  getGatePublicKey: vi.fn().mockReturnValue(null),
}));

vi.mock('../utils/batchAuth.js', () => ({
  hasGateToken: vi.fn().mockReturnValue(false),
  getGateToken: vi.fn().mockReturnValue(''),
  setGateToken: vi.fn(),
  clearGateToken: vi.fn(),
}));

vi.mock('../engine/batchScan.js', () => ({
  batchScan: vi.fn().mockResolvedValue([]),
}));

// Stub service-worker registration used by UpdatePrompt (vite-plugin-pwa)
vi.mock('virtual:pwa-register', () => ({
  registerSW: vi.fn(() => () => {}),
}), { virtual: true });

import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('App smoke tests', () => {
  it('renders without throwing (catches TDZ / init errors)', async () => {
    // This single test would have caught the production TDZ crash where
    // a useEffect referenced `view` before it was declared.
    const App = (await import('../App.jsx')).default;
    expect(() => render(<App />)).not.toThrow();
  });

  it('renders SearchBar with a text input in the main view', async () => {
    const App = (await import('../App.jsx')).default;
    render(<App />);

    // Multiple pages are always-mounted (hidden). Use getAllBy and verify at least one exists.
    const inputs = screen.getAllByPlaceholderText(/search symbol/i);
    expect(inputs.length).toBeGreaterThanOrEqual(1);
    expect(inputs[0]).toBeInTheDocument();
  });

  it('renders the Scan button', async () => {
    const App = (await import('../App.jsx')).default;
    render(<App />);

    const scanBtns = screen.getAllByRole('button', { name: /scan/i });
    expect(scanBtns.length).toBeGreaterThanOrEqual(1);
  });

  it('search input accepts typed text', async () => {
    const App = (await import('../App.jsx')).default;
    render(<App />);

    // The first search input belongs to the visible main view
    const inputs = screen.getAllByPlaceholderText(/search symbol/i);
    const mainInput = inputs[0];
    await userEvent.type(mainInput, 'reliance');
    // Input uppercases the value
    expect(mainInput.value).toBe('RELIANCE');
  });

  it('shows dropdown suggestions when typing a known symbol', async () => {
    const { fetchNseIndexWithNames } = await import('../engine/nseIndexFetch.js');
    fetchNseIndexWithNames.mockResolvedValue({
      symbols: ['RELIANCE', 'RELIANCEINFRA', 'TCS', 'INFY'],
      companyMap: {
        RELIANCE: 'Reliance Industries Ltd',
        RELIANCEINFRA: 'Reliance Infra Ltd',
        TCS: 'Tata Consultancy Services',
        INFY: 'Infosys Ltd',
      },
    });

    const App = (await import('../App.jsx')).default;
    render(<App />);

    // Wait for async effects to settle (index fetch)
    await waitFor(() => {});

    const inputs = screen.getAllByPlaceholderText(/search symbol/i);
    await userEvent.type(inputs[0], 'RE');

    // Dropdown should show matching suggestions
    await waitFor(() => {
      expect(screen.getByText('RELIANCE')).toBeInTheDocument();
    });
  });

  it('renders the empty state on initial load', async () => {
    const App = (await import('../App.jsx')).default;
    render(<App />);
    const emptyTexts = screen.getAllByText(/enter a symbol/i);
    expect(emptyTexts.length).toBeGreaterThanOrEqual(1);
  });

  it('renders the footer disclaimer', async () => {
    const App = (await import('../App.jsx')).default;
    render(<App />);
    const disclaimers = screen.getAllByText(/not financial advice/i);
    expect(disclaimers.length).toBeGreaterThanOrEqual(1);
  });

  it('renders the CandleScan header', async () => {
    const App = (await import('../App.jsx')).default;
    render(<App />);
    // The header should contain "CandleScan" text
    expect(screen.getByText(/candlescan/i)).toBeInTheDocument();
  });
});
