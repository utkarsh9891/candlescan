// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import TokenExpiryBanner from '../TokenExpiryBanner.jsx';

afterEach(() => {
  cleanup();
});

describe('TokenExpiryBanner', () => {
  it('renders nothing when broker is falsy', () => {
    const { container } = render(<TokenExpiryBanner broker={null} onOpenSettings={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the Dhan copy when broker="dhan"', () => {
    render(<TokenExpiryBanner broker="dhan" onOpenSettings={() => {}} />);
    expect(screen.getByTestId('token-expiry-banner')).toBeTruthy();
    expect(screen.getByText(/Dhan session expired/i)).toBeTruthy();
    expect(screen.getByText(/re-link from Settings/i)).toBeTruthy();
  });

  it('renders the Zerodha copy when broker="kite"', () => {
    render(<TokenExpiryBanner broker="kite" onOpenSettings={() => {}} />);
    expect(screen.getByText(/Zerodha session expired/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Reconnect Zerodha/i })).toBeTruthy();
  });

  it('invokes onOpenSettings when the reconnect button is clicked', () => {
    const onOpenSettings = vi.fn();
    render(<TokenExpiryBanner broker="dhan" onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByTestId('token-expiry-reconnect-btn'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('omits the reconnect button when onOpenSettings is not supplied', () => {
    render(<TokenExpiryBanner broker="dhan" />);
    // Banner itself still renders
    expect(screen.getByTestId('token-expiry-banner')).toBeTruthy();
    // ...but no button
    expect(screen.queryByTestId('token-expiry-reconnect-btn')).toBeNull();
  });
});
