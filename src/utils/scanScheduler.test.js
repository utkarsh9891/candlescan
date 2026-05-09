import { describe, it, expect, vi } from 'vitest';
import {
  decideNextScan,
  getCadenceMs,
  scheduleNext,
  cadenceLabel,
} from './scanScheduler.js';

const ONE_MIN = 60 * 1000;
const FIVE_MIN = 5 * ONE_MIN;
const FIFTEEN_MIN = 15 * ONE_MIN;

const baseState = {
  engine: 'scalp',
  timeframe: '1m',
  now: 1_000_000,
  lastScanAt: null,
  marketIsOpen: true,
  tabVisible: true,
  scanInFlight: false,
  hasBlockingError: false,
};

describe('getCadenceMs', () => {
  it('returns 60s for scalp/1m', () => {
    expect(getCadenceMs('scalp', '1m')).toBe(ONE_MIN);
  });
  it('returns 5m for intraday/5m', () => {
    expect(getCadenceMs('intraday', '5m')).toBe(FIVE_MIN);
  });
  it('returns 15m for intraday/15m', () => {
    expect(getCadenceMs('intraday', '15m')).toBe(FIFTEEN_MIN);
  });
  it('returns intraday default when timeframe unknown', () => {
    expect(getCadenceMs('intraday', '30m')).toBe(FIVE_MIN);
  });
  it('returns scalp default for unknown timeframe', () => {
    expect(getCadenceMs('scalp', '1h')).toBe(ONE_MIN);
  });
  it('returns null for delivery', () => {
    expect(getCadenceMs('delivery', '1d')).toBe(null);
  });
  it('returns null for unknown engine', () => {
    expect(getCadenceMs('mystery', '1m')).toBe(null);
  });
});

describe('decideNextScan — pause conditions', () => {
  it('idles when scan is in flight', () => {
    const r = decideNextScan({ ...baseState, scanInFlight: true });
    expect(r).toEqual({ action: 'idle', reason: 'scan-in-flight' });
  });
  it('idles on blocking error', () => {
    const r = decideNextScan({ ...baseState, hasBlockingError: true });
    expect(r).toEqual({ action: 'idle', reason: 'blocking-error' });
  });
  it('idles when tab is hidden', () => {
    const r = decideNextScan({ ...baseState, tabVisible: false });
    expect(r).toEqual({ action: 'idle', reason: 'tab-hidden' });
  });
  it('idles when market is closed', () => {
    const r = decideNextScan({ ...baseState, marketIsOpen: false });
    expect(r).toEqual({ action: 'idle', reason: 'market-closed' });
  });
  it('idles for delivery engine', () => {
    const r = decideNextScan({ ...baseState, engine: 'delivery', timeframe: '1d' });
    expect(r).toEqual({ action: 'idle', reason: 'engine-disabled' });
  });

  // Priority of idle reasons: scanInFlight > blockingError > visibility > market > engine.
  // This ordering matters — UI surfaces "scan in flight" so the user knows
  // not to click again, but should not surface "tab hidden" if a scan is
  // actually running.
  it('reports scan-in-flight even when tab hidden', () => {
    const r = decideNextScan({ ...baseState, scanInFlight: true, tabVisible: false });
    expect(r.reason).toBe('scan-in-flight');
  });
});

describe('decideNextScan — fire/wait conditions', () => {
  it('fires immediately when no prior scan in session', () => {
    const r = decideNextScan({ ...baseState, lastScanAt: null });
    expect(r).toEqual({ action: 'fire', delayMs: 0 });
  });

  it('fires immediately when last scan was longer than cadence ago', () => {
    const r = decideNextScan({ ...baseState, lastScanAt: 0 }); // very old
    expect(r).toEqual({ action: 'fire', delayMs: 0 });
  });

  it('waits when last scan is within cadence window', () => {
    const r = decideNextScan({
      ...baseState,
      lastScanAt: baseState.now - 30 * 1000, // 30s ago for 60s cadence
    });
    expect(r.action).toBe('wait');
    expect(r.delayMs).toBe(30 * 1000);
  });

  it('intraday/5m: waits 4m if last scan was 1m ago', () => {
    const r = decideNextScan({
      ...baseState,
      engine: 'intraday',
      timeframe: '5m',
      lastScanAt: baseState.now - ONE_MIN,
    });
    expect(r).toEqual({ action: 'wait', delayMs: 4 * ONE_MIN });
  });
});

describe('scheduleNext', () => {
  it('schedules a 0ms timer when action is fire', () => {
    const onFire = vi.fn();
    const setTimeoutFn = vi.fn((fn, ms) => `t-${ms}`);
    const { handle, decision } = scheduleNext({
      state: baseState,
      onFire,
      setTimeoutFn,
    });
    expect(decision.action).toBe('fire');
    expect(handle).toBe('t-0');
    expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 0);
  });

  it('schedules the wait delay when action is wait', () => {
    const onFire = vi.fn();
    const setTimeoutFn = vi.fn((fn, ms) => `t-${ms}`);
    const fixedNow = 5_000_000;
    const realNow = Date.now;
    Date.now = () => fixedNow;
    try {
      const state = { ...baseState, lastScanAt: fixedNow - 30_000 };
      const { handle, decision } = scheduleNext({
        state,
        onFire,
        setTimeoutFn,
      });
      expect(decision.action).toBe('wait');
      expect(decision.delayMs).toBe(30_000);
      expect(handle).toBe('t-30000');
    } finally {
      Date.now = realNow;
    }
  });

  it('returns no handle when action is idle', () => {
    const onFire = vi.fn();
    const setTimeoutFn = vi.fn();
    const state = { ...baseState, marketIsOpen: false };
    const { handle, decision } = scheduleNext({
      state,
      onFire,
      setTimeoutFn,
    });
    expect(decision.action).toBe('idle');
    expect(handle).toBe(null);
    expect(setTimeoutFn).not.toHaveBeenCalled();
  });

  it('uses Date.now() at call time so wait shrinks as time passes', () => {
    const onFire = vi.fn();
    const setTimeoutFn = vi.fn((fn, ms) => ms);
    const fixedNow = 5_000_000;
    const realNow = Date.now;
    Date.now = () => fixedNow;
    try {
      const state = { ...baseState, lastScanAt: fixedNow - 20_000 };
      const { decision } = scheduleNext({ state, onFire, setTimeoutFn });
      expect(decision.action).toBe('wait');
      expect(decision.delayMs).toBe(40_000);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('cadenceLabel', () => {
  it('formats 60s', () => {
    expect(cadenceLabel('scalp', '1m')).toBe('1m');
  });
  it('formats 5m', () => {
    expect(cadenceLabel('intraday', '5m')).toBe('5m');
  });
  it('formats 15m', () => {
    expect(cadenceLabel('intraday', '15m')).toBe('15m');
  });
  it('returns "manual only" for delivery', () => {
    expect(cadenceLabel('delivery', '1d')).toBe('manual only');
  });
});
