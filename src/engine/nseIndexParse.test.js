import { describe, it, expect } from 'vitest';
import { parseNseIndexSymbols } from './nseIndexParse.js';

describe('parseNseIndexSymbols', () => {
  it('extracts EQ symbols from valid payload', () => {
    const payload = {
      data: [
        { symbol: 'RELIANCE', series: 'EQ' },
        { symbol: 'TCS', series: 'EQ' },
        { symbol: 'INFY', series: 'EQ' },
      ],
    };
    expect(parseNseIndexSymbols(payload)).toEqual(['RELIANCE', 'TCS', 'INFY']);
  });

  it('filters out non-EQ series', () => {
    const payload = {
      data: [
        { symbol: 'RELIANCE', series: 'EQ' },
        { symbol: 'RELIANCE', series: 'BE' },
        { symbol: 'RELIANCE-RE', series: 'RR' },
      ],
    };
    expect(parseNseIndexSymbols(payload)).toEqual(['RELIANCE']);
  });

  it('deduplicates symbols', () => {
    const payload = {
      data: [
        { symbol: 'TCS', series: 'EQ' },
        { symbol: 'TCS', series: 'EQ' },
        { symbol: 'tcs', series: 'EQ' },
      ],
    };
    expect(parseNseIndexSymbols(payload)).toEqual(['TCS']);
  });

  it('normalizes to uppercase', () => {
    const payload = { data: [{ symbol: 'reliance', series: 'EQ' }] };
    expect(parseNseIndexSymbols(payload)).toEqual(['RELIANCE']);
  });

  it('trims whitespace', () => {
    const payload = { data: [{ symbol: '  TCS  ', series: 'EQ' }] };
    expect(parseNseIndexSymbols(payload)).toEqual(['TCS']);
  });

  it('skips rows with missing symbol', () => {
    const payload = { data: [{ series: 'EQ' }, { symbol: 'TCS', series: 'EQ' }] };
    expect(parseNseIndexSymbols(payload)).toEqual(['TCS']);
  });

  it('skips null/undefined rows', () => {
    const payload = { data: [null, undefined, { symbol: 'INFY', series: 'EQ' }] };
    expect(parseNseIndexSymbols(payload)).toEqual(['INFY']);
  });

  it('returns empty array for null/undefined payload', () => {
    expect(parseNseIndexSymbols(null)).toEqual([]);
    expect(parseNseIndexSymbols(undefined)).toEqual([]);
    expect(parseNseIndexSymbols({})).toEqual([]);
  });

  it('returns empty array when data is not an array', () => {
    expect(parseNseIndexSymbols({ data: 'not array' })).toEqual([]);
    expect(parseNseIndexSymbols({ data: 42 })).toEqual([]);
  });

  it('returns empty array for empty data', () => {
    expect(parseNseIndexSymbols({ data: [] })).toEqual([]);
  });
});
