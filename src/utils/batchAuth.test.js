import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getBatchToken, setBatchToken, hasBatchToken, clearBatchToken } from './batchAuth.js';

const store = {};
const localStorageMock = {
  getItem: vi.fn((key) => store[key] ?? null),
  setItem: vi.fn((key, val) => { store[key] = val; }),
  removeItem: vi.fn((key) => { delete store[key]; }),
};

beforeEach(() => {
  Object.keys(store).forEach((k) => delete store[k]);
  vi.stubGlobal('localStorage', localStorageMock);
});

describe('batchAuth', () => {
  it('getBatchToken returns empty string when no token set', () => {
    expect(getBatchToken()).toBe('');
  });

  it('hasBatchToken returns false when no token set', () => {
    expect(hasBatchToken()).toBe(false);
  });

  it('setBatchToken stores and getBatchToken retrieves', () => {
    setBatchToken('mySecret123');
    expect(getBatchToken()).toBe('mySecret123');
    expect(hasBatchToken()).toBe(true);
  });

  it('clearBatchToken removes the token', () => {
    setBatchToken('mySecret123');
    clearBatchToken();
    expect(getBatchToken()).toBe('');
    expect(hasBatchToken()).toBe(false);
  });

  it('setBatchToken overwrites previous token', () => {
    setBatchToken('first');
    setBatchToken('second');
    expect(getBatchToken()).toBe('second');
  });
});
