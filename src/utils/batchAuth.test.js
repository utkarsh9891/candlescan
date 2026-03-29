import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getBatchToken, setBatchToken, hasBatchToken, clearBatchToken } from './batchAuth.js';

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

describe('batchAuth', () => {
  it('getBatchToken returns empty string when no token set', () => {
    expect(getBatchToken()).toBe('');
  });

  it('hasBatchToken returns false when no token set', () => {
    expect(hasBatchToken()).toBe(false);
  });

  it('setBatchToken hashes and stores, getBatchToken retrieves hash', async () => {
    await setBatchToken('mySecret123');
    const token = getBatchToken();
    expect(token).toBeTruthy();
    expect(token).not.toBe('mySecret123'); // must NOT be plaintext
    expect(token.length).toBe(64); // SHA-256 hex = 64 chars
    expect(hasBatchToken()).toBe(true);
  });

  it('clearBatchToken removes the token', async () => {
    await setBatchToken('mySecret123');
    clearBatchToken();
    expect(getBatchToken()).toBe('');
    expect(hasBatchToken()).toBe(false);
  });

  it('setBatchToken is deterministic for same input', async () => {
    await setBatchToken('test');
    const hash1 = getBatchToken();
    clearBatchToken();
    await setBatchToken('test');
    const hash2 = getBatchToken();
    expect(hash1).toBe(hash2);
  });

  it('different passphrases produce different hashes', async () => {
    await setBatchToken('first');
    const h1 = getBatchToken();
    clearBatchToken();
    await setBatchToken('second');
    const h2 = getBatchToken();
    expect(h1).not.toBe(h2);
  });
});
