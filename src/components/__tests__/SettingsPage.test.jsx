// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import SettingsPage from '../SettingsPage.jsx';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../utils/batchAuth.js', () => ({
  hasGateToken: vi.fn().mockReturnValue(false),
  getGateToken: vi.fn().mockReturnValue(''),
  setGateToken: vi.fn(),
  clearGateToken: vi.fn(),
}));

vi.mock('../../utils/credentialVault.js', () => ({
  getVaultBlob: vi.fn().mockReturnValue(null),
  hasVault: vi.fn().mockReturnValue(false),
  clearVault: vi.fn(),
  unlockGate: vi.fn(),
  encryptToVault: vi.fn(),
  clearGate: vi.fn(),
  getGatePublicKey: vi.fn().mockReturnValue(null),
}));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderSettings(overrides = {}) {
  const props = {
    onBack: vi.fn(),
    debugMode: false,
    onDebugModeChange: vi.fn(),
    ...overrides,
  };
  return render(<SettingsPage {...props} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettingsPage', () => {
  it('renders without crashing', () => {
    expect(() => renderSettings()).not.toThrow();
  });

  it('displays the Settings heading', () => {
    renderSettings();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });

  it('renders the back button', () => {
    renderSettings();
    expect(screen.getByLabelText(/go back/i)).toBeInTheDocument();
  });

  it('renders the Premium Gate section', () => {
    renderSettings();
    expect(screen.getByText(/premium gate/i)).toBeInTheDocument();
    expect(screen.getByText('Locked')).toBeInTheDocument();
  });

  it('renders the Data Source section', () => {
    renderSettings();
    expect(screen.getByText(/data source/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/yahoo finance/i)).toBeInTheDocument();
  });

  it('renders the Debug mode toggle', () => {
    renderSettings();
    expect(screen.getByLabelText(/debug mode/i)).toBeInTheDocument();
  });

  it('renders the About section', () => {
    renderSettings();
    expect(screen.getByText(/about/i)).toBeInTheDocument();
  });

  describe('tokenStatus states', () => {
    it('shows "Locked" when gate is locked (no token)', () => {
      renderSettings();
      // The gate status shows "Locked" text
      const lockedElements = screen.getAllByText('Locked');
      expect(lockedElements.length).toBeGreaterThan(0);
      expect(screen.getByPlaceholderText('Passphrase')).toBeInTheDocument();
    });

    it('shows "Unlocked" / "Premium Active" when gate is unlocked', async () => {
      const { hasGateToken } = await import('../../utils/batchAuth.js');
      hasGateToken.mockReturnValue(true);

      renderSettings();

      expect(screen.getByText('Unlocked')).toBeInTheDocument();
      expect(screen.getByText('Premium Active')).toBeInTheDocument();
    });

    it('shows token status "Not connected" when vault is empty and Zerodha selected', async () => {
      const { hasGateToken } = await import('../../utils/batchAuth.js');
      const { hasVault } = await import('../../utils/credentialVault.js');
      hasGateToken.mockReturnValue(true);
      hasVault.mockReturnValue(false);

      // Set data source to zerodha in localStorage before render
      localStorage.setItem('candlescan_data_source', 'zerodha');

      renderSettings();

      // With gate unlocked and zerodha selected, the Zerodha section appears
      expect(screen.getByText('Not connected')).toBeInTheDocument();
    });

    it('shows "Checking token..." when vault exists and zerodha selected', async () => {
      const { hasGateToken, getGateToken } = await import('../../utils/batchAuth.js');
      const { hasVault, getVaultBlob } = await import('../../utils/credentialVault.js');
      hasGateToken.mockReturnValue(true);
      getGateToken.mockReturnValue('abc123');
      hasVault.mockReturnValue(true);
      getVaultBlob.mockReturnValue('encrypted-blob');

      localStorage.setItem('candlescan_data_source', 'zerodha');

      // Mock fetch for the validation call — never resolves to keep status as 'checking'
      globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {}));

      renderSettings();

      expect(screen.getByText('Checking token...')).toBeInTheDocument();

      // Clean up
      delete globalThis.fetch;
    });
  });
});
