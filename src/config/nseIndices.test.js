import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NSE_INDEX_OPTIONS, DEFAULT_NSE_INDEX_ID, addCustomIndex, removeCustomIndex, getCustomIndices, getAllIndexOptions } from './nseIndices.js';

// Mock localStorage
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

describe('NSE_INDEX_OPTIONS', () => {
  it('is a non-empty array', () => {
    expect(NSE_INDEX_OPTIONS.length).toBeGreaterThan(0);
  });

  it('each option has id and label', () => {
    for (const opt of NSE_INDEX_OPTIONS) {
      expect(opt).toHaveProperty('id');
      expect(opt).toHaveProperty('label');
      expect(typeof opt.id).toBe('string');
      expect(typeof opt.label).toBe('string');
    }
  });

  it('has no duplicate ids', () => {
    const ids = NSE_INDEX_OPTIONS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('DEFAULT_NSE_INDEX_ID', () => {
  it('is a valid index id', () => {
    expect(NSE_INDEX_OPTIONS.some((o) => o.id === DEFAULT_NSE_INDEX_ID)).toBe(true);
  });
});

describe('custom indices', () => {
  it('getCustomIndices returns empty array when no custom indices', () => {
    expect(getCustomIndices()).toEqual([]);
  });

  it('addCustomIndex adds a new custom index', () => {
    const result = addCustomIndex('NIFTY BANK');
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('NIFTY BANK');
    expect(result[0].label).toContain('custom');
  });

  it('addCustomIndex does not duplicate', () => {
    addCustomIndex('NIFTY BANK');
    const result = addCustomIndex('NIFTY BANK');
    expect(result.length).toBe(1);
  });

  it('addCustomIndex does not add built-in indices', () => {
    const result = addCustomIndex('NIFTY 50');
    expect(result.length).toBe(0);
  });

  it('addCustomIndex normalizes to uppercase', () => {
    const result = addCustomIndex('nifty bank');
    expect(result[0].id).toBe('NIFTY BANK');
  });

  it('removeCustomIndex removes by id', () => {
    addCustomIndex('NIFTY BANK');
    addCustomIndex('NIFTY IT');
    const result = removeCustomIndex('NIFTY BANK');
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('NIFTY IT');
  });

  it('getAllIndexOptions merges built-in and custom', () => {
    addCustomIndex('NIFTY BANK');
    const all = getAllIndexOptions();
    expect(all.length).toBe(NSE_INDEX_OPTIONS.length + 1);
    expect(all[all.length - 1].id).toBe('NIFTY BANK');
  });
});
