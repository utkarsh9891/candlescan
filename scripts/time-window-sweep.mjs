#!/usr/bin/env node
/**
 * time-window-sweep.mjs — sweep trading windows to calibrate the best
 * intraday start/end for the scalp engine.
 *
 * Research question: "Is 09:30–11:00 actually the best window, or is
 * 10:30–12:30 comparable?" This is a *measurement* script — it does not
 * change engine behavior. It spawns `node scripts/simulate-day.mjs` with
 * --from / --to flags across a set of candidate windows on every day in
 * the 17-day canonical window Mar 12 – Apr 10 2026 and aggregates per-window
 * performance (mean daily P&L, WR, PF, max drawdown, total trades).
 *
 * Pattern matches `scripts/walk-forward.mjs`:
 *   - child_process workers for the existing simulate-day.mjs CLI (no
 *     shared-lib carve-out, to minimize merge surface)
 *   - concurrency-capped queue (default 6)
 *   - markdown table + JSON artifact under cache/time-window-sweep/
 *
 * IMPORTANT — race avoidance: simulate-day.mjs writes
 * cache/trades/<date>.json unconditionally. If two workers for the same
 * date ran concurrently they'd race on that file. We therefore serialize
 * per-date (a mutex on `date`) while still running up to N different
 * dates in parallel. Each worker's trades file is captured immediately
 * on child exit and copied to
 * cache/time-window-sweep/trades/<from>-<to>/<date>.json for the artifact.
 *
 * Usage:
 *   node scripts/time-window-sweep.mjs                         # 17-day canonical window
 *   node scripts/time-window-sweep.mjs --from 2026-04-01 --to 2026-04-21
 *   node scripts/time-window-sweep.mjs --concurrency 8
 *   node scripts/time-window-sweep.mjs --windows "09:30-11:00,10:30-12:30"
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listCachedDates } from './lib/chart-cache-fs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SIMULATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'simulate-day.mjs');
const TRADES_DIR = path.join(REPO_ROOT, 'cache', 'trades');
const OUT_DIR = path.join(REPO_ROOT, 'cache', 'time-window-sweep');
const PER_WINDOW_TRADES_DIR = path.join(OUT_DIR, 'trades');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_WINDOWS = [
  { from: '09:30', to: '11:00' },
  { from: '09:30', to: '12:00' },
  { from: '10:00', to: '11:30' },
  { from: '10:30', to: '12:30' },
  { from: '11:00', to: '13:00' },
  { from: '13:00', to: '14:30' },
  { from: '09:30', to: '15:00' }, // full-day reference
];

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/**
 * Parse a "HH:MM-HH:MM,HH:MM-HH:MM,..." string into a window list.
 * Invalid entries are skipped silently so CLI typos don't blow up the run.
 * @param {string} spec
 * @returns {Array<{from:string,to:string}>}
 */
export function parseWindowsSpec(spec) {
  if (!spec || typeof spec !== 'string') return [];
  const out = [];
  const seen = new Set();
  for (const raw of spec.split(',')) {
    const s = raw.trim();
    if (!s) continue;
    const m = s.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
    if (!m) continue;
    const key = `${m[1]}-${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: m[1], to: m[2] });
  }
  return out;
}

export function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    from: '2026-03-12',
    to: '2026-04-10',
    index: 'NIFTY SMALLCAP 100',
    engine: 'scalp',
    confidence: 75,
    maxPositions: 1,
    positionSize: 300000,
    maxTrades: 5,
    concurrency: Math.min(Math.max(os.cpus().length - 1, 1), 6),
    pessimisticFills: true,
    windows: DEFAULT_WINDOWS.slice(),
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    switch (a) {
      case '--from': opts.from = next(); break;
      case '--to': opts.to = next(); break;
      case '--index': opts.index = next(); break;
      case '--engine': opts.engine = next(); break;
      case '--confidence': opts.confidence = +next(); break;
      case '--max-positions': opts.maxPositions = +next(); break;
      case '--position-size': opts.positionSize = +next(); break;
      case '--max-trades': opts.maxTrades = +next(); break;
      case '--concurrency': opts.concurrency = +next(); break;
      case '--pessimistic-fills': opts.pessimisticFills = true; break;
      case '--no-pessimistic-fills': opts.pessimisticFills = false; break;
      case '--windows': {
        const parsed = parseWindowsSpec(next());
        if (parsed.length) opts.windows = parsed;
        break;
      }
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        break;
    }
  }
  return opts;
}

function printHelp() {
  process.stdout.write(
    [
      'time-window-sweep.mjs — sweep trading windows to calibrate best start/end',
      '',
      'Usage:',
      '  node scripts/time-window-sweep.mjs [flags]',
      '',
      'Flags:',
      '  --from YYYY-MM-DD       start of sweep window (default: 2026-03-12)',
      '  --to YYYY-MM-DD         end of sweep window (default: 2026-04-10)',
      '  --index "NAME"          NSE index (default: "NIFTY SMALLCAP 100")',
      '  --engine scalp|v2       engine selector (default: scalp)',
      '  --confidence N          min confidence (default: 75)',
      '  --max-positions N       parallel positions (default: 1)',
      '  --position-size RS      per-position capital (default: 300000)',
      '  --max-trades N          per-day trade cap (default: 5)',
      '  --concurrency N         parallel workers (default: min(cpus-1, 6))',
      '  --windows "A-B,C-D"     comma-separated HH:MM-HH:MM list',
      '  --pessimistic-fills     enable (default ON)',
      '  --no-pessimistic-fills  disable',
      '',
    ].join('\n') + '\n',
  );
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Filter and sort a list of YYYY-MM-DD date strings to the [from, to] window.
 * (Same contract as walk-forward.mjs::enumerateTradingDays — duplicated here
 * to keep this script's test imports self-contained.)
 * @param {string} from inclusive YYYY-MM-DD
 * @param {string} to inclusive YYYY-MM-DD
 * @param {string[]} allDates candidate trading days (any order)
 * @returns {string[]} sorted ascending, within [from, to]
 */
export function enumerateTradingDays(from, to, allDates) {
  const lo = String(from);
  const hi = String(to);
  return Array.from(new Set(allDates))
    .filter((d) => d >= lo && d <= hi)
    .sort();
}

/** Canonical string label for a window, e.g. "09:30-11:00". */
export function windowLabel(w) {
  return `${w.from}-${w.to}`;
}

/**
 * Aggregate per-pair run records into per-window performance stats.
 *
 * Input: array of { window: "HH:MM-HH:MM", date: "YYYY-MM-DD", status, summary, trades }
 *   - `summary.totalPnl` is the sum of netPnl across trades for that day.
 *   - `trades` is the per-trade array (each with a numeric `netPnl`).
 *   - Missing / failed / partial records contribute nothing.
 *
 * Output: Array<{ label, meanDailyPnl, winRate, profitFactor, maxDrawdown,
 *   totalTrades, totalPnl, daysCovered, daysTotal, bestDay, worstDay }>,
 * sorted by meanDailyPnl descending.
 *
 * Semantics:
 *   - winRate: wins / (wins + losses) over all trades in the window
 *   - profitFactor: sum(winning netPnl) / |sum(losing netPnl)|
 *     - infinity if there are wins but no losses
 *     - 0 if there are no wins at all
 *   - maxDrawdown: peak-to-trough of cumulative daily P&L (date-sorted)
 *   - bestDay / worstDay: the single-day max / min totalPnl
 *
 * @param {Array<object>} records
 */
export function aggregateByWindow(records) {
  const byWindow = new Map();
  for (const r of records) {
    if (!r || !r.window) continue;
    if (!byWindow.has(r.window)) byWindow.set(r.window, []);
    byWindow.get(r.window).push(r);
  }

  const out = [];
  for (const [label, rows] of byWindow) {
    // Sum pnl, wins/losses, trades. Treat failed/partial days as 0.
    let totalPnl = 0;
    let wins = 0;
    let losses = 0;
    let grossWin = 0;
    let grossLoss = 0;
    let totalTrades = 0;
    let daysCovered = 0;
    let bestDay = null;
    let worstDay = null;

    // Sort by date for a stable drawdown computation.
    const sortedRows = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)));

    let running = 0;
    let peak = 0;
    let maxDrawdown = 0;

    for (const row of sortedRows) {
      if (!row || row.status !== 'ok' || !row.summary) continue;
      daysCovered++;
      const pnl = Number(row.summary.totalPnl || 0);
      totalPnl += pnl;
      running += pnl;
      peak = Math.max(peak, running);
      const dd = peak - running;
      if (dd > maxDrawdown) maxDrawdown = dd;

      if (bestDay === null || pnl > bestDay.pnl) bestDay = { date: row.date, pnl };
      if (worstDay === null || pnl < worstDay.pnl) worstDay = { date: row.date, pnl };

      const trades = Array.isArray(row.trades) ? row.trades : [];
      for (const t of trades) {
        const n = Number(t?.netPnl || 0);
        totalTrades++;
        if (n > 0) { wins++; grossWin += n; }
        else { losses++; grossLoss += Math.abs(n); }
      }
    }

    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    let profitFactor;
    if (grossLoss > 0) profitFactor = grossWin / grossLoss;
    else profitFactor = grossWin > 0 ? Infinity : 0;
    const meanDailyPnl = daysCovered > 0 ? totalPnl / daysCovered : 0;

    out.push({
      label,
      meanDailyPnl,
      winRate,
      profitFactor,
      maxDrawdown,
      totalTrades,
      totalPnl,
      daysCovered,
      daysTotal: rows.length,
      bestDay,
      worstDay,
    });
  }

  out.sort((a, b) => b.meanDailyPnl - a.meanDailyPnl);
  return out;
}

// ---------------------------------------------------------------------------
// Worker orchestration
// ---------------------------------------------------------------------------

function buildWorkerArgs(date, w, opts) {
  const a = [
    SIMULATE_SCRIPT,
    '1m',
    '--date', date,
    '--index', opts.index,
    '--engine', opts.engine,
    '--confidence', String(opts.confidence),
    '--max-positions', String(opts.maxPositions),
    '--position-size', String(opts.positionSize),
    '--max-trades', String(opts.maxTrades),
    '--from', w.from,
    '--to', w.to,
  ];
  if (opts.pessimisticFills) a.push('--pessimistic-fills');
  else a.push('--no-pessimistic-fills');
  return a;
}

function tailLines(s, n) {
  const arr = String(s || '').split(/\r?\n/);
  return arr.slice(Math.max(0, arr.length - n)).join('\n');
}

function readTradesFile(date) {
  const p = path.join(TRADES_DIR, `${date}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function persistPerWindowTrades(label, date, trades) {
  const dir = path.join(PER_WINDOW_TRADES_DIR, label);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(trades, null, 2), 'utf8');
}

/**
 * Run one simulate-day worker for (date, window). Resolves a per-pair record.
 * Never throws — failures are encoded in the record.
 */
function runOne(date, w, opts, livePool) {
  const label = windowLabel(w);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const args = buildWorkerArgs(date, w, opts);
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    livePool.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('error', (err) => {
      livePool.delete(child);
      resolve({
        window: label,
        date,
        status: 'failed',
        reason: `spawn error: ${err.message}`,
        wallMs: Date.now() - startedAt,
      });
    });
    child.on('exit', (code, signal) => {
      livePool.delete(child);
      const wallMs = Date.now() - startedAt;
      if (signal) {
        resolve({ window: label, date, status: 'killed', reason: `signal ${signal}`, wallMs });
        return;
      }
      if (code !== 0) {
        process.stderr.write(
          `[window-sweep] ${date} ${label} worker exited ${code}\n--- stdout tail ---\n${tailLines(stdout, 20)}\n--- stderr tail ---\n${tailLines(stderr, 10)}\n\n`,
        );
        resolve({
          window: label,
          date,
          status: 'failed',
          reason: `exit ${code}`,
          wallMs,
          stdoutTail: tailLines(stdout, 20),
        });
        return;
      }
      // Success — read trades file IMMEDIATELY (per-date mutex below
      // guarantees no concurrent writer for this date).
      const tradesPayload = readTradesFile(date);
      if (!tradesPayload) {
        process.stderr.write(
          `[window-sweep] ${date} ${label} worker ok but cache/trades/${date}.json missing\n`,
        );
        resolve({ window: label, date, status: 'partial', reason: 'no trades file', wallMs });
        return;
      }
      // Copy out to the per-window artifact dir before another window for the
      // same date overwrites the shared file.
      try { persistPerWindowTrades(label, date, tradesPayload); } catch { /* noop */ }
      resolve({
        window: label,
        date,
        status: 'ok',
        wallMs,
        runMeta: tradesPayload.runMeta || null,
        summary: tradesPayload.summary || null,
        trades: Array.isArray(tradesPayload.trades) ? tradesPayload.trades : [],
      });
    });
  });
}

/**
 * Run (date, window) pairs with a per-date mutex (only one worker per date
 * at a time) and a global concurrency cap across different dates.
 *
 * @param {string[]} dates
 * @param {Array<{from:string,to:string}>} windows
 * @param {object} opts
 * @param {Set<import('node:child_process').ChildProcess>} livePool
 */
async function runParallel(dates, windows, opts, livePool) {
  const limit = Math.max(1, opts.concurrency | 0);
  const total = dates.length * windows.length;
  process.stdout.write(
    `[window-sweep] ${dates.length} day(s) x ${windows.length} window(s) = ${total} run(s), up to ${limit} concurrent\n`,
  );

  // Per-date work queue: each date owns a queue of windows. At most ONE
  // worker per date runs at any time (to avoid cache/trades/<date>.json
  // races). Across dates we honor the global concurrency cap.
  const queues = new Map(dates.map((d) => [d, windows.slice()]));
  const dateBusy = new Set();
  const allDates = dates.slice();

  const results = [];
  let active = 0;
  let completed = 0;

  return new Promise((resolve) => {
    const launchNext = () => {
      // If everything done, resolve.
      if (active === 0) {
        const anyRemaining = allDates.some((d) => (queues.get(d) || []).length > 0);
        if (!anyRemaining) {
          resolve(results);
          return;
        }
      }
      // Fill up to `limit` workers.
      while (active < limit) {
        // Find a date that (a) has queued work, (b) isn't currently busy.
        const nextDate = allDates.find(
          (d) => !dateBusy.has(d) && (queues.get(d) || []).length > 0,
        );
        if (!nextDate) break; // nothing launchable right now
        const w = queues.get(nextDate).shift();
        dateBusy.add(nextDate);
        active++;
        const label = windowLabel(w);
        process.stdout.write(
          `[window-sweep] -> start ${nextDate} ${label} (active ${active}/${limit})\n`,
        );
        runOne(nextDate, w, opts, livePool).then((rec) => {
          results.push(rec);
          completed++;
          active--;
          dateBusy.delete(nextDate);
          const pnl = rec.summary?.totalPnl;
          process.stdout.write(
            `[window-sweep] <- done  ${nextDate} ${label} status=${rec.status} ` +
            `pnl=${Number.isFinite(pnl) ? Math.round(pnl) : 'n/a'} ` +
            `wall=${(rec.wallMs / 1000).toFixed(1)}s (${completed}/${total})\n`,
          );
          launchNext();
        });
      }
    };
    launchNext();
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function fmtSignedRs(n) {
  if (!Number.isFinite(n)) return '-';
  const sign = n < 0 ? '-' : '';
  return `${sign}Rs ${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
}

function fmtPf(pf) {
  if (pf === Infinity) return 'inf';
  if (!Number.isFinite(pf)) return '-';
  return pf.toFixed(2);
}

function fmtPct(n) {
  if (!Number.isFinite(n)) return '-';
  return `${n.toFixed(1)}%`;
}

function renderRankedTable(ranked) {
  const out = [];
  out.push('## Window ranking (by mean daily P&L)');
  out.push('');
  out.push('| Window         | Mean Daily P&L | WR%  | PF   | Max DD     | Trades |');
  out.push('|----------------|---------------:|-----:|-----:|-----------:|-------:|');
  for (const r of ranked) {
    out.push(
      `| ${r.label.padEnd(14)} | ${fmtSignedRs(r.meanDailyPnl).padStart(14)} | ` +
      `${fmtPct(r.winRate).padStart(4)} | ${fmtPf(r.profitFactor).padStart(4)} | ` +
      `${fmtSignedRs(-r.maxDrawdown).padStart(10)} | ${String(r.totalTrades).padStart(6)} |`,
    );
  }
  return out.join('\n');
}

function renderDetailsTable(ranked) {
  const out = [];
  out.push('## Window details');
  out.push('');
  out.push('| Window         | Days | Total P&L       | Best Day                 | Worst Day                |');
  out.push('|----------------|-----:|----------------:|--------------------------|--------------------------|');
  for (const r of ranked) {
    const best = r.bestDay ? `${r.bestDay.date} ${fmtSignedRs(r.bestDay.pnl)}` : '-';
    const worst = r.worstDay ? `${r.worstDay.date} ${fmtSignedRs(r.worstDay.pnl)}` : '-';
    out.push(
      `| ${r.label.padEnd(14)} | ${String(r.daysCovered).padStart(4)} | ` +
      `${fmtSignedRs(r.totalPnl).padStart(15)} | ${best.padEnd(24)} | ${worst.padEnd(24)} |`,
    );
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const allDates = listCachedDates('^NSEI', '1m');
  const days = enumerateTradingDays(opts.from, opts.to, allDates);
  if (days.length === 0) {
    process.stderr.write(
      `[window-sweep] no trading days in [${opts.from}, ${opts.to}] — warm the cache first (npm run cache:charts).\n`,
    );
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(PER_WINDOW_TRADES_DIR, { recursive: true });

  // Ctrl+C — kill children, exit 130.
  const livePool = new Set();
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    process.stderr.write('\n[window-sweep] SIGINT — killing workers\n');
    for (const c of livePool) {
      try { c.kill('SIGTERM'); } catch { /* noop */ }
    }
    setTimeout(() => {
      process.stderr.write('[window-sweep] exiting 130 (partial results discarded)\n');
      process.exit(130);
    }, 300).unref();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const sweepStart = Date.now();
  const records = await runParallel(days, opts.windows, opts, livePool);
  const wallMs = Date.now() - sweepStart;

  const ranked = aggregateByWindow(records);

  // Reports to stdout.
  process.stdout.write('\n' + renderRankedTable(ranked) + '\n\n');
  process.stdout.write(renderDetailsTable(ranked) + '\n\n');

  const failed = records.filter((r) => r.status !== 'ok').length;
  process.stdout.write(
    `[window-sweep] ${records.length - failed}/${records.length} runs ok, ` +
    `total wall ${(wallMs / 1000).toFixed(1)}s\n`,
  );

  // JSON artifact.
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifact = {
    generatedAt: new Date().toISOString(),
    opts: { ...opts, windows: opts.windows.map(windowLabel) },
    days,
    records,
    ranked,
    wallMs,
  };
  const outPath = path.join(OUT_DIR, `window-sweep-${timestamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');
  process.stdout.write(`\n[window-sweep] artifact: ${outPath}\n`);

  process.exit(failed > 0 && records.filter((r) => r.status === 'ok').length === 0 ? 1 : 0);
}

const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[window-sweep] fatal: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
