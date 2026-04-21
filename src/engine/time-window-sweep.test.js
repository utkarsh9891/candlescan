import { describe, it, expect } from 'vitest';
import {
  aggregateByWindow,
  enumerateTradingDays,
  parseArgs,
  parseWindowsSpec,
  windowLabel,
  DEFAULT_WINDOWS,
} from '../../scripts/time-window-sweep.mjs';

// ---------------------------------------------------------------------------
// aggregateByWindow — the main math-bearing helper.
// ---------------------------------------------------------------------------

// Fixture: 2 windows x 3 days. Values picked so mean / PF / WR / DD are
// computable by hand.
//
//   09:30-11:00:
//     2026-03-12: trades [+1000, -500]      => day pnl +500
//     2026-03-13: trades [+2000]            => day pnl +2000
//     2026-03-14: trades [-1500, -500]      => day pnl -2000
//     => sum = +500  (mean = +166.666..)
//     => wins = 2, losses = 3, WR = 40%
//     => grossWin = 1000+2000 = 3000, grossLoss = 500+1500+500 = 2500
//     => PF = 3000/2500 = 1.2
//     => daily cumulative: 500, 2500, 500 => peak 2500, trough 500 => DD 2000
//
//   10:30-12:30:
//     2026-03-12: trades [+300]             => day pnl +300
//     2026-03-13: trades [+400, -100]       => day pnl +300
//     2026-03-14: trades [+200]             => day pnl +200
//     => sum = +800  (mean = +266.666..)
//     => wins = 3, losses = 1, WR = 75%
//     => grossWin = 300+400+200 = 900, grossLoss = 100
//     => PF = 9.0
//     => daily cumulative: 300, 600, 800 => no drawdown (monotonic up) => DD 0
const FIXTURE = [
  {
    window: '09:30-11:00',
    date: '2026-03-12',
    status: 'ok',
    summary: { totalPnl: 500 },
    trades: [{ netPnl: 1000 }, { netPnl: -500 }],
  },
  {
    window: '09:30-11:00',
    date: '2026-03-13',
    status: 'ok',
    summary: { totalPnl: 2000 },
    trades: [{ netPnl: 2000 }],
  },
  {
    window: '09:30-11:00',
    date: '2026-03-14',
    status: 'ok',
    summary: { totalPnl: -2000 },
    trades: [{ netPnl: -1500 }, { netPnl: -500 }],
  },
  {
    window: '10:30-12:30',
    date: '2026-03-12',
    status: 'ok',
    summary: { totalPnl: 300 },
    trades: [{ netPnl: 300 }],
  },
  {
    window: '10:30-12:30',
    date: '2026-03-13',
    status: 'ok',
    summary: { totalPnl: 300 },
    trades: [{ netPnl: 400 }, { netPnl: -100 }],
  },
  {
    window: '10:30-12:30',
    date: '2026-03-14',
    status: 'ok',
    summary: { totalPnl: 200 },
    trades: [{ netPnl: 200 }],
  },
];

describe('aggregateByWindow', () => {
  it('computes correct per-window stats over a 2x3 fixture and ranks by mean daily P&L', () => {
    const ranked = aggregateByWindow(FIXTURE);
    expect(ranked).toHaveLength(2);

    // 10:30-12:30 has higher mean daily P&L (266 vs 166) → it ranks first.
    expect(ranked[0].label).toBe('10:30-12:30');
    expect(ranked[1].label).toBe('09:30-11:00');

    const morning = ranked.find((r) => r.label === '09:30-11:00');
    expect(morning.totalPnl).toBe(500);
    expect(morning.meanDailyPnl).toBeCloseTo(500 / 3, 6);
    expect(morning.daysCovered).toBe(3);
    expect(morning.totalTrades).toBe(5);
    expect(morning.winRate).toBeCloseTo(40, 5); // 2/5
    expect(morning.profitFactor).toBeCloseTo(1.2, 5); // 3000/2500
    expect(morning.maxDrawdown).toBe(2000); // peak 2500 → trough 500
    expect(morning.bestDay).toEqual({ date: '2026-03-13', pnl: 2000 });
    expect(morning.worstDay).toEqual({ date: '2026-03-14', pnl: -2000 });

    const late = ranked.find((r) => r.label === '10:30-12:30');
    expect(late.totalPnl).toBe(800);
    expect(late.meanDailyPnl).toBeCloseTo(800 / 3, 6);
    expect(late.totalTrades).toBe(4);
    expect(late.winRate).toBeCloseTo(75, 5); // 3/4
    expect(late.profitFactor).toBeCloseTo(9.0, 5); // 900/100
    expect(late.maxDrawdown).toBe(0); // monotonic climb
  });

  it('skips failed / partial rows', () => {
    const records = [
      ...FIXTURE,
      { window: '09:30-11:00', date: '2026-03-15', status: 'failed', reason: 'exit 1' },
      { window: '10:30-12:30', date: '2026-03-15', status: 'partial', reason: 'no trades file' },
    ];
    const ranked = aggregateByWindow(records);
    // daysCovered should still be 3 (failed/partial do not count).
    const morning = ranked.find((r) => r.label === '09:30-11:00');
    const late = ranked.find((r) => r.label === '10:30-12:30');
    expect(morning.daysCovered).toBe(3);
    expect(late.daysCovered).toBe(3);
    expect(morning.daysTotal).toBe(4); // 3 ok + 1 failed
    expect(late.daysTotal).toBe(4);
  });

  it('returns PF=Infinity when there are wins but no losses', () => {
    const ranked = aggregateByWindow([
      {
        window: '09:30-11:00',
        date: '2026-03-12',
        status: 'ok',
        summary: { totalPnl: 500 },
        trades: [{ netPnl: 500 }],
      },
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].profitFactor).toBe(Infinity);
    expect(ranked[0].winRate).toBe(100);
  });

  it('returns PF=0 when there are no wins at all', () => {
    const ranked = aggregateByWindow([
      {
        window: '09:30-11:00',
        date: '2026-03-12',
        status: 'ok',
        summary: { totalPnl: -500 },
        trades: [{ netPnl: -500 }],
      },
    ]);
    expect(ranked[0].profitFactor).toBe(0);
    expect(ranked[0].winRate).toBe(0);
  });

  it('handles an empty input', () => {
    expect(aggregateByWindow([])).toEqual([]);
  });

  it('computes max drawdown correctly with a mid-series peak', () => {
    // daily pnl: +1000, +500, -2000, +300
    // running:   1000, 1500, -500, -200
    // peak:      1000, 1500, 1500, 1500
    // dd:           0,    0, 2000, 1700  → max 2000
    const ranked = aggregateByWindow([
      { window: 'W', date: '2026-03-12', status: 'ok', summary: { totalPnl: 1000 }, trades: [] },
      { window: 'W', date: '2026-03-13', status: 'ok', summary: { totalPnl: 500 }, trades: [] },
      { window: 'W', date: '2026-03-14', status: 'ok', summary: { totalPnl: -2000 }, trades: [] },
      { window: 'W', date: '2026-03-15', status: 'ok', summary: { totalPnl: 300 }, trades: [] },
    ]);
    expect(ranked[0].maxDrawdown).toBe(2000);
    expect(ranked[0].bestDay).toEqual({ date: '2026-03-12', pnl: 1000 });
    expect(ranked[0].worstDay).toEqual({ date: '2026-03-14', pnl: -2000 });
  });
});

// ---------------------------------------------------------------------------
// Other pure helpers.
// ---------------------------------------------------------------------------

describe('enumerateTradingDays', () => {
  it('filters to inclusive [from, to] and sorts ascending, deduped', () => {
    const out = enumerateTradingDays('2026-03-01', '2026-03-20', [
      '2026-03-20', '2026-03-05', '2026-02-27', '2026-03-12', '2026-04-01', '2026-03-05',
    ]);
    expect(out).toEqual(['2026-03-05', '2026-03-12', '2026-03-20']);
  });

  it('returns empty on empty input', () => {
    expect(enumerateTradingDays('2026-01-01', '2026-12-31', [])).toEqual([]);
  });
});

describe('parseWindowsSpec', () => {
  it('parses a well-formed list', () => {
    expect(parseWindowsSpec('09:30-11:00,10:30-12:30')).toEqual([
      { from: '09:30', to: '11:00' },
      { from: '10:30', to: '12:30' },
    ]);
  });

  it('skips invalid tokens and dedupes', () => {
    expect(parseWindowsSpec('09:30-11:00, garbage ,09:30-11:00, 10:00-11:30')).toEqual([
      { from: '09:30', to: '11:00' },
      { from: '10:00', to: '11:30' },
    ]);
  });

  it('returns empty for empty / bogus input', () => {
    expect(parseWindowsSpec('')).toEqual([]);
    expect(parseWindowsSpec(null)).toEqual([]);
    expect(parseWindowsSpec('nonsense')).toEqual([]);
  });
});

describe('windowLabel', () => {
  it('formats as "HH:MM-HH:MM"', () => {
    expect(windowLabel({ from: '09:30', to: '11:00' })).toBe('09:30-11:00');
  });
});

describe('parseArgs', () => {
  it('uses canonical defaults', () => {
    const opts = parseArgs(['node', 'time-window-sweep.mjs']);
    expect(opts.from).toBe('2026-03-12');
    expect(opts.to).toBe('2026-04-10');
    expect(opts.index).toBe('NIFTY SMALLCAP 100');
    expect(opts.engine).toBe('scalp');
    expect(opts.confidence).toBe(75);
    expect(opts.maxPositions).toBe(1);
    expect(opts.positionSize).toBe(300000);
    expect(opts.maxTrades).toBe(5);
    expect(opts.pessimisticFills).toBe(true);
    expect(opts.windows).toEqual(DEFAULT_WINDOWS);
    expect(opts.concurrency).toBeGreaterThanOrEqual(1);
    expect(opts.concurrency).toBeLessThanOrEqual(6);
  });

  it('overrides defaults from flags', () => {
    const opts = parseArgs([
      'node', 'time-window-sweep.mjs',
      '--from', '2026-04-01',
      '--to', '2026-04-21',
      '--concurrency', '8',
      '--windows', '09:30-11:00,10:30-12:30',
      '--no-pessimistic-fills',
    ]);
    expect(opts.from).toBe('2026-04-01');
    expect(opts.to).toBe('2026-04-21');
    expect(opts.concurrency).toBe(8);
    expect(opts.pessimisticFills).toBe(false);
    expect(opts.windows).toEqual([
      { from: '09:30', to: '11:00' },
      { from: '10:30', to: '12:30' },
    ]);
  });

  it('keeps default windows when --windows parses to empty', () => {
    const opts = parseArgs(['node', 'time-window-sweep.mjs', '--windows', 'garbage']);
    expect(opts.windows).toEqual(DEFAULT_WINDOWS);
  });
});
