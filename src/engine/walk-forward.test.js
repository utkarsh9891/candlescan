import { describe, it, expect } from 'vitest';
import {
  enumerateTradingDays,
  buildWindows,
  aggregateWindow,
  bucketResults,
  parseArgs,
  buildWorkerArgs,
} from '../../scripts/walk-forward.mjs';

// 15-day fixture (consecutive weekdays ignored — dates here are just labels).
const FIFTEEN_DAYS = [
  '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06',
  '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13',
  '2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19', '2026-03-20',
];

describe('enumerateTradingDays', () => {
  it('filters a mixed list to the inclusive [from, to] window and sorts ascending', () => {
    const all = [
      '2026-03-20', '2026-03-05', '2026-02-27', '2026-03-12', '2026-04-01',
    ];
    const out = enumerateTradingDays('2026-03-01', '2026-03-20', all);
    expect(out).toEqual(['2026-03-05', '2026-03-12', '2026-03-20']);
  });

  it('handles empty input', () => {
    expect(enumerateTradingDays('2026-01-01', '2026-12-31', [])).toEqual([]);
  });

  it('dedupes when the same date appears twice', () => {
    const out = enumerateTradingDays('2026-03-01', '2026-03-31', [
      '2026-03-10', '2026-03-10', '2026-03-11',
    ]);
    expect(out).toEqual(['2026-03-10', '2026-03-11']);
  });

  it('excludes dates outside the window (boundary tests)', () => {
    const all = ['2026-03-01', '2026-03-02', '2026-03-03'];
    // inclusive lower bound
    expect(enumerateTradingDays('2026-03-02', '2026-03-03', all)).toEqual([
      '2026-03-02', '2026-03-03',
    ]);
    // inclusive upper bound already covered above; check strict exclusion
    expect(enumerateTradingDays('2026-03-04', '2026-03-10', all)).toEqual([]);
  });
});

describe('buildWindows', () => {
  it('produces sliding windows with stride=1 over a 15-day fixture', () => {
    const ws = buildWindows(FIFTEEN_DAYS, 10, 3, 1);
    // 15 - 10 - 3 + 1 = 3 windows
    expect(ws).toHaveLength(3);
    expect(ws[0].train).toEqual(FIFTEEN_DAYS.slice(0, 10));
    expect(ws[0].test).toEqual(FIFTEEN_DAYS.slice(10, 13));
    expect(ws[1].train).toEqual(FIFTEEN_DAYS.slice(1, 11));
    expect(ws[1].test).toEqual(FIFTEEN_DAYS.slice(11, 14));
    expect(ws[2].train).toEqual(FIFTEEN_DAYS.slice(2, 12));
    expect(ws[2].test).toEqual(FIFTEEN_DAYS.slice(12, 15));
  });

  it('honors stride > 1', () => {
    const ws = buildWindows(FIFTEEN_DAYS, 10, 3, 2);
    // indices 0, 2 are valid (i=0: train 0..10, test 10..13; i=2: train 2..12, test 12..15)
    expect(ws).toHaveLength(2);
    expect(ws[0].train[0]).toBe(FIFTEEN_DAYS[0]);
    expect(ws[1].train[0]).toBe(FIFTEEN_DAYS[2]);
  });

  it('returns empty when the fixture is too small', () => {
    expect(buildWindows(FIFTEEN_DAYS.slice(0, 5), 10, 3, 1)).toEqual([]);
  });

  it('each window carries a sequential idx', () => {
    const ws = buildWindows(FIFTEEN_DAYS, 10, 3, 1);
    expect(ws.map((w) => w.idx)).toEqual([0, 1, 2]);
  });

  it('rejects non-positive params', () => {
    expect(buildWindows(FIFTEEN_DAYS, 0, 3, 1)).toEqual([]);
    expect(buildWindows(FIFTEEN_DAYS, 10, 0, 1)).toEqual([]);
    expect(buildWindows(FIFTEEN_DAYS, 10, 3, 0)).toEqual([]);
  });
});

describe('aggregateWindow', () => {
  const results = {
    '2026-03-01': { date: '2026-03-01', status: 'ok', summary: { totalPnl: 1000, wins: 2, losses: 1 } },
    '2026-03-02': { date: '2026-03-02', status: 'ok', summary: { totalPnl: -500, wins: 1, losses: 2 } },
    '2026-03-03': { date: '2026-03-03', status: 'ok', summary: { totalPnl: 2000, wins: 3, losses: 0 } },
    '2026-03-04': { date: '2026-03-04', status: 'failed', reason: 'exit 1' }, // no summary
  };

  it('sums totalPnl correctly', () => {
    const agg = aggregateWindow(results, ['2026-03-01', '2026-03-02', '2026-03-03']);
    expect(agg.pnl).toBe(2500);
    expect(agg.wins).toBe(6);
    expect(agg.losses).toBe(3);
    expect(agg.trades).toBe(9);
    expect(agg.wr).toBeCloseTo((6 / 9) * 100, 5);
    expect(agg.covered).toBe(3);
    expect(agg.total).toBe(3);
  });

  it('treats missing and failed days as zero', () => {
    const agg = aggregateWindow(results, ['2026-03-01', '2026-03-04', '2026-99-99']);
    expect(agg.pnl).toBe(1000);
    expect(agg.wins).toBe(2);
    expect(agg.losses).toBe(1);
    expect(agg.covered).toBe(1);
    expect(agg.total).toBe(3);
  });

  it('returns zero WR on an empty window', () => {
    const agg = aggregateWindow(results, []);
    expect(agg).toMatchObject({ pnl: 0, wins: 0, losses: 0, trades: 0, wr: 0, covered: 0, total: 0 });
  });
});

describe('bucketResults', () => {
  it('keys records by date', () => {
    const records = [
      { date: '2026-03-01', status: 'ok', summary: { totalPnl: 100 } },
      { date: '2026-03-02', status: 'failed', reason: 'x' },
    ];
    const b = bucketResults(records);
    expect(b['2026-03-01'].summary.totalPnl).toBe(100);
    expect(b['2026-03-02'].status).toBe('failed');
  });

  it('ignores records without a date', () => {
    const records = [null, undefined, { status: 'ok' }, { date: '2026-03-01', status: 'ok' }];
    const b = bucketResults(records);
    expect(Object.keys(b)).toEqual(['2026-03-01']);
  });

  it('last-write-wins on duplicate dates', () => {
    const records = [
      { date: '2026-03-01', status: 'ok', summary: { totalPnl: 1 } },
      { date: '2026-03-01', status: 'ok', summary: { totalPnl: 2 } },
    ];
    const b = bucketResults(records);
    expect(b['2026-03-01'].summary.totalPnl).toBe(2);
  });
});

describe('parseArgs', () => {
  it('applies sensible defaults when no flags are passed', () => {
    const opts = parseArgs(['node', 'walk-forward.mjs']);
    expect(opts.from).toBe('2026-03-12');
    expect(opts.index).toBe('NIFTY SMALLCAP 100');
    expect(opts.engine).toBe('scalp');
    expect(opts.confidence).toBe(75);
    expect(opts.maxPositions).toBe(1);
    expect(opts.positionSize).toBe(300000);
    expect(opts.maxTrades).toBe(5);
    expect(opts.trainDays).toBe(10);
    expect(opts.testDays).toBe(3);
    expect(opts.stride).toBe(1);
    expect(opts.pessimisticFills).toBe(true);
    expect(opts.concurrency).toBeGreaterThanOrEqual(1);
    expect(opts.concurrency).toBeLessThanOrEqual(6);
  });

  it('overrides defaults from flags', () => {
    const opts = parseArgs([
      'node', 'walk-forward.mjs',
      '--from', '2026-04-01',
      '--to', '2026-04-10',
      '--index', 'NIFTY 50',
      '--confidence', '80',
      '--train-days', '5',
      '--test-days', '2',
      '--stride', '1',
      '--concurrency', '3',
      '--no-pessimistic-fills',
    ]);
    expect(opts.from).toBe('2026-04-01');
    expect(opts.to).toBe('2026-04-10');
    expect(opts.index).toBe('NIFTY 50');
    expect(opts.confidence).toBe(80);
    expect(opts.trainDays).toBe(5);
    expect(opts.testDays).toBe(2);
    expect(opts.concurrency).toBe(3);
    expect(opts.pessimisticFills).toBe(false);
  });

  it('parses --timeframe (default 1m, override accepted verbatim)', () => {
    const def = parseArgs(['node', 'walk-forward.mjs']);
    expect(def.timeframe).toBe('1m');
    const ov = parseArgs(['node', 'walk-forward.mjs', '--timeframe', '15m']);
    expect(ov.timeframe).toBe('15m');
  });

  it('parses --size-tiers as a verbatim string forwarded to the worker', () => {
    const def = parseArgs(['node', 'walk-forward.mjs']);
    expect(def.sizeTiers).toBe(null);
    const ov = parseArgs(['node', 'walk-forward.mjs', '--size-tiers', '82:200000,75:100000']);
    expect(ov.sizeTiers).toBe('82:200000,75:100000');
  });

  it('normalizes legacy v2/v1/classic engine codes', () => {
    expect(parseArgs(['node', 'walk-forward.mjs', '--engine', 'v2']).engine).toBe('intraday');
    expect(parseArgs(['node', 'walk-forward.mjs', '--engine', 'v1']).engine).toBe('delivery');
    expect(parseArgs(['node', 'walk-forward.mjs', '--engine', 'classic']).engine).toBe('delivery');
    expect(parseArgs(['node', 'walk-forward.mjs', '--engine', 'intraday']).engine).toBe('intraday');
  });
});

describe('buildWorkerArgs', () => {
  const baseOpts = {
    timeframe: '1m', index: 'NIFTY SMALLCAP 100', engine: 'scalp',
    confidence: 75, maxPositions: 1, positionSize: 300000, maxTrades: 5,
    pessimisticFills: true, regimeAwareStops: true, sizeTiers: null,
  };

  it('includes the timeframe as the first positional arg', () => {
    const args = buildWorkerArgs('2026-04-22', baseOpts);
    // index 0 is SIMULATE_SCRIPT path; index 1 is the timeframe arg
    expect(args[1]).toBe('1m');
  });

  it('forwards a non-default --timeframe', () => {
    const args = buildWorkerArgs('2026-04-22', { ...baseOpts, timeframe: '15m' });
    expect(args[1]).toBe('15m');
  });

  it('forwards --size-tiers when set, omits when null', () => {
    const off = buildWorkerArgs('2026-04-22', baseOpts);
    expect(off).not.toContain('--size-tiers');

    const on = buildWorkerArgs('2026-04-22', { ...baseOpts, sizeTiers: '82:200000,75:100000' });
    const idx = on.indexOf('--size-tiers');
    expect(idx).toBeGreaterThan(0);
    expect(on[idx + 1]).toBe('82:200000,75:100000');
  });

  it('always includes --regime-stops or --no-regime-stops (no silent fallback)', () => {
    const on = buildWorkerArgs('2026-04-22', { ...baseOpts, regimeAwareStops: true });
    expect(on).toContain('--regime-stops');
    const off = buildWorkerArgs('2026-04-22', { ...baseOpts, regimeAwareStops: false });
    expect(off).toContain('--no-regime-stops');
  });

  it('forwards canonical engine names', () => {
    const a = buildWorkerArgs('2026-04-22', { ...baseOpts, engine: 'intraday' });
    const idx = a.indexOf('--engine');
    expect(a[idx + 1]).toBe('intraday');
  });
});
