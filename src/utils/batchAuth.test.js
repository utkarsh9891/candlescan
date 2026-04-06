import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getGateToken, setGateToken, hasGateToken, clearGateToken,
         getBatchToken, setBatchToken, hasBatchToken, clearBatchToken } from './batchAuth.js';

const store = {};
const localStorageMock = {
  getItem: vi.fn((key) => store[key] ?? null),
  setItem: vi.fn((key, val) => { store[key] = val; }),
  removeItem: vi.fn((key) => { delete store[key]; }),
};

// Mock crypto.subtle for SHA-256 in Node test environment
const cryptoMock = {
  subtle: {
    digest: vi.fn(async (algo, data) => {
      // Simple mock: return deterministic bytes based on input
      const arr = new Uint8Array(32);
      for (let i = 0; i < Math.min(data.length, 32); i++) arr[i] = data[i];
      return arr.buffer;
    }),
  },
};

beforeEach(() => {
  Object.keys(store).forEach((k) => delete store[k]);
  vi.stubGlobal('localStorage', localStorageMock);
  vi.stubGlobal('crypto', cryptoMock);
});

describe('gateAuth', () => {
  it('getGateToken returns empty string when no token set', () => {
    expect(getGateToken()).toBe('');
  });

  it('hasGateToken returns false when no token set', () => {
    expect(hasGateToken()).toBe(false);
  });

  it('setGateToken hashes and stores, getGateToken retrieves hash', async () => {
    await setGateToken('mySecret123');
    const token = getGateToken();
    expect(token).toBeTruthy();
    expect(token).not.toBe('mySecret123'); // must NOT be plaintext
    expect(token.length).toBe(64); // SHA-256 hex = 64 chars
    expect(hasGateToken()).toBe(true);
  });

  it('clearGateToken removes the token', async () => {
    await setGateToken('mySecret123');
    clearGateToken();
    expect(getGateToken()).toBe('');
    expect(hasGateToken()).toBe(false);
  });

  it('setGateToken is deterministic for same input', async () => {
    await setGateToken('test');
    const hash1 = getGateToken();
    clearGateToken();
    await setGateToken('test');
    const hash2 = getGateToken();
    expect(hash1).toBe(hash2);
  });

  it('different passphrases produce different hashes', async () => {
    await setGateToken('first');
    const h1 = getGateToken();
    clearGateToken();
    await setGateToken('second');
    const h2 = getGateToken();
    expect(h1).not.toBe(h2);
  });

  it('legacy re-exports work', () => {
    expect(getBatchToken).toBe(getGateToken);
    expect(setBatchToken).toBe(setGateToken);
    expect(hasBatchToken).toBe(hasGateToken);
    expect(clearBatchToken).toBe(clearGateToken);
  });

  it('stores under candlescan_gate_hash key', async () => {
    await setGateToken('test');
    expect(store['candlescan_gate_hash']).toBeTruthy();
    expect(store['candlescan_gate_hash'].length).toBe(64);
  });
});
