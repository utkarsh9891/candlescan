import { describe, it, expect } from 'vitest';
import { diffSectorSets } from './sector-freshness.js';

describe('diffSectorSets', () => {
  it('empty-identical: no drift', () => {
    const hardcoded = { HDFCBANK: 'BANK', INFY: 'IT' };
    const live = { BANK: ['HDFCBANK'], IT: ['INFY'] };
    const diff = diffSectorSets(hardcoded, live);
    expect(diff.hasDrift).toBe(false);
    expect(diff.totals).toEqual({ upToDate: 2, missing: 0, stale: 0, mismatched: 0 });
    expect(diff.perSector.BANK.upToDate).toEqual(['HDFCBANK']);
    expect(diff.perSector.IT.upToDate).toEqual(['INFY']);
    expect(diff.perSector.BANK.missing).toEqual([]);
    expect(diff.perSector.BANK.stale).toEqual([]);
    expect(diff.perSector.BANK.mismatched).toEqual([]);
  });

  it('one missing: symbol in live index but not in hardcoded', () => {
    const hardcoded = { HDFCBANK: 'BANK' };
    const live = { BANK: ['HDFCBANK', 'ICICIBANK'] };
    const diff = diffSectorSets(hardcoded, live);
    expect(diff.hasDrift).toBe(true);
    expect(diff.perSector.BANK.missing).toEqual(['ICICIBANK']);
    expect(diff.perSector.BANK.upToDate).toEqual(['HDFCBANK']);
    expect(diff.perSector.BANK.stale).toEqual([]);
    expect(diff.perSector.BANK.mismatched).toEqual([]);
    expect(diff.totals.missing).toBe(1);
  });

  it('one stale: symbol in hardcoded but not in live index', () => {
    const hardcoded = { HDFCBANK: 'BANK', OLDBANK: 'BANK' };
    const live = { BANK: ['HDFCBANK'] };
    const diff = diffSectorSets(hardcoded, live);
    expect(diff.hasDrift).toBe(true);
    expect(diff.perSector.BANK.stale).toEqual(['OLDBANK']);
    expect(diff.perSector.BANK.upToDate).toEqual(['HDFCBANK']);
    expect(diff.perSector.BANK.missing).toEqual([]);
    expect(diff.perSector.BANK.mismatched).toEqual([]);
    expect(diff.totals.stale).toBe(1);
  });

  it('one mismatched: symbol mapped to different sector in hardcoded', () => {
    const hardcoded = { RELIANCE: 'OIL' };
    const live = { ENERGY: ['RELIANCE'] };
    const diff = diffSectorSets(hardcoded, live);
    expect(diff.hasDrift).toBe(true);
    expect(diff.perSector.ENERGY.mismatched).toEqual([
      { symbol: 'RELIANCE', hardcodedSector: 'OIL', liveSector: 'ENERGY' },
    ]);
    expect(diff.perSector.ENERGY.missing).toEqual([]);
    expect(diff.perSector.ENERGY.upToDate).toEqual([]);
    expect(diff.totals.mismatched).toBe(1);
  });

  it('handles empty inputs gracefully', () => {
    expect(diffSectorSets({}, {}).hasDrift).toBe(false);
    expect(diffSectorSets(null, null).hasDrift).toBe(false);
    expect(diffSectorSets(undefined, undefined).totals).toEqual({
      upToDate: 0,
      missing: 0,
      stale: 0,
      mismatched: 0,
    });
  });

  it('stale symbol also tagged for original sector bucket', () => {
    // Symbol moved from FIN to BANK in NSE; hardcoded still says FIN.
    const hardcoded = { HDFCBANK: 'FIN' };
    const live = { BANK: ['HDFCBANK'], FIN: [] };
    const diff = diffSectorSets(hardcoded, live);
    expect(diff.hasDrift).toBe(true);
    // BANK (live sector) sees it as mismatched.
    expect(diff.perSector.BANK.mismatched).toEqual([
      { symbol: 'HDFCBANK', hardcodedSector: 'FIN', liveSector: 'BANK' },
    ]);
    // FIN (old hardcoded sector) sees it as stale.
    expect(diff.perSector.FIN.stale).toEqual(['HDFCBANK']);
  });

  it('sorts output arrays for stable reports', () => {
    const hardcoded = {};
    const live = { IT: ['TCS', 'INFY', 'WIPRO'] };
    const diff = diffSectorSets(hardcoded, live);
    expect(diff.perSector.IT.missing).toEqual(['INFY', 'TCS', 'WIPRO']);
  });
});
