#!/usr/bin/env node
/**
 * walk-forward.mjs — parallel walk-forward simulation harness.
 *
 * Spawns multiple `node scripts/simulate-day.mjs` workers in parallel to sweep
 * many trading days quickly, then aggregates results into rolling train / test
 * windows for walk-forward validation.
 *
 * DESIGN RATIONALE — why `child_process` instead of a shared lib:
 *   The obvious alternative is to extract the simulate-day core into a pure
 *   function and call it N times in-process. We deliberately DO NOT do that.
 *   `scripts/simulate-day.mjs` is under active development (multiple PRs in
 *   flight touching its internals). Carving out a shared lib would produce
 *   merge conflicts on every concurrent PR. By shelling out to the existing
 *   CLI as a black box we keep the diff surface minimal — this file plus its
 *   unit test — and inherit any upstream fixes for free.
 *
 * The parallel PR teaches simulate-day.mjs to write `cache/trades/<date>.json`
 * per run. We consume those files here. If the file is missing we degrade
 * gracefully (flag the day as partial, skip aggregation for it).
 *
 * Usage:
 *   node scripts/walk-forward.mjs \
 *     --from 2026-03-12 --to 2026-04-10 \
 *     --index "NIFTY SMALLCAP 100" \
 *     --engine scalp --confidence 75 \
 *     --max-positions 1 --position-size 300000 --max-trades 5 \
 *     --train-days 10 --test-days 3 --stride 1 \
 *     --concurrency 4
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
const WF_OUT_DIR = path.join(REPO_ROOT, 'cache', 'walk-forward');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/** Return today's date in IST as YYYY-MM-DD. */
export function todayIst() {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const now = new Date(Date.now() + IST_OFFSET_MS);
  return now.toISOString().slice(0, 10);
}

export function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    from: '2026-03-12',
    to: todayIst(),
    index: 'NIFTY SMALLCAP 100',
    engine: 'scalp',
    confidence: 75,
    maxPositions: 1,
    positionSize: 300000,
    maxTrades: 5,
    concurrency: Math.min(Math.max(os.cpus().length - 1, 1), 6),
    trainDays: 10,
    testDays: 3,
    stride: 1,
    pessimisticFills: true,
    // Regime-aware ATR-based SL/target (P2 #11 + Wave 2a tuning). Default
    // ON matches simulate-day.mjs — flip with --no-regime-stops to A/B
    // against the legacy 0.5%/1.0% hardcoded path.
    regimeAwareStops: true,
    // Per-bar timeframe forwarded as the first positional arg to
    // simulate-day.mjs. '1m' is the scalp default; intraday A/B uses
    // '5m' or '15m'. Validated downstream by TIMEFRAME_MAP.
    timeframe: '1m',
    // Confidence-tiered base sizing string forwarded verbatim to
    // --size-tiers in the worker. Parsed (and validated) by the worker
    // via parseSizeTiers — failing fast there avoids duplicating
    // validation logic in the harness.
    sizeTiers: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    switch (a) {
      case '--from': opts.from = next(); break;
      case '--to': opts.to = next(); break;
      case '--index': opts.index = next(); break;
      case '--engine': {
        const raw = next();
        if (raw === 'v2') opts.engine = 'intraday';
        else if (raw === 'v1' || raw === 'classic') opts.engine = 'delivery';
        else opts.engine = raw;
        break;
      }
      case '--confidence': opts.confidence = +next(); break;
      case '--max-positions': opts.maxPositions = +next(); break;
      case '--position-size': opts.positionSize = +next(); break;
      case '--max-trades': opts.maxTrades = +next(); break;
      case '--concurrency': opts.concurrency = +next(); break;
      case '--train-days': opts.trainDays = +next(); break;
      case '--test-days': opts.testDays = +next(); break;
      case '--stride': opts.stride = +next(); break;
      case '--pessimistic-fills': opts.pessimisticFills = true; break;
      case '--no-pessimistic-fills': opts.pessimisticFills = false; break;
      case '--regime-stops': opts.regimeAwareStops = true; break;
      case '--no-regime-stops': opts.regimeAwareStops = false; break;
      case '--timeframe': opts.timeframe = next(); break;
      case '--size-tiers': opts.sizeTiers = next(); break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        // ignore unknown flags for forward-compat
        break;
    }
  }
  return opts;
}

function printHelp() {
  process.stdout.write(
    [
      'walk-forward.mjs — parallel walk-forward simulation harness',
      '',
      'Usage:',
      '  node scripts/walk-forward.mjs [flags]',
      '',
      'Flags:',
      '  --from YYYY-MM-DD       start of sweep window (default: 2026-03-12)',
      '  --to YYYY-MM-DD         end of sweep window (default: today IST)',
      '  --index "NAME"          NSE index (default: "NIFTY SMALLCAP 100")',
      '  --engine NAME           engine selector: scalp | intraday | delivery (default: scalp)',
      '                          legacy aliases: v2→intraday, v1/classic→delivery',
      '  --confidence N          min confidence (default: 75)',
      '  --max-positions N       parallel positions (default: 1)',
      '  --position-size RS      per-position capital (default: 300000)',
      '  --max-trades N          per-day trade cap (default: 5)',
      '  --concurrency N         parallel workers (default: min(cpus-1, 6))',
      '  --train-days N          rolling train window size (default: 10)',
      '  --test-days N           test slice per window (default: 3)',
      '  --stride N              window advance step (default: 1)',
      '  --pessimistic-fills     enable (default ON)',
      '  --no-pessimistic-fills  disable',
      '  --regime-stops          enable regime-aware ATR-based SL/target (default ON)',
      '  --no-regime-stops       disable (use legacy 0.5%/1.0% hardcoded path)',
      '  --timeframe TF          per-bar timeframe forwarded to simulate-day (default: 1m)',
      '                          intraday A/B: pass 5m or 15m; delivery: 1d',
      '  --size-tiers STR        confidence-tiered base sizing, e.g. "82:200000,75:100000"',
      '                          omit to use flat --position-size for every trade',
      '',
    ].join('\n') + '\n',
  );
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Filter and sort a list of YYYY-MM-DD date strings to the [from, to] window.
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

/**
 * Build rolling train/test windows over a sorted list of dates.
 * Advances by `stride`, stops when there is no full test slice left.
 * @param {string[]} dates ascending YYYY-MM-DD
 * @param {number} trainDays
 * @param {number} testDays
 * @param {number} stride
 * @returns {Array<{idx:number, train:string[], test:string[]}>}
 */
export function buildWindows(dates, trainDays, testDays, stride) {
  const out = [];
  if (trainDays <= 0 || testDays <= 0 || stride <= 0) return out;
  const step = Math.max(1, stride | 0);
  let idx = 0;
  for (let i = 0; i + trainDays + testDays <= dates.length; i += step) {
    out.push({
      idx: idx++,
      train: dates.slice(i, i + trainDays),
      test: dates.slice(i + trainDays, i + trainDays + testDays),
    });
  }
  return out;
}

/**
 * Sum totalPnl, wins, losses and compute WR over a subset of dates.
 * Days with no result (or failed runs) contribute 0 P&L and 0 trades.
 * @param {Object<string,{summary?:{totalPnl?:number,wins?:number,losses?:number}}>} results
 *   keyed by date (YYYY-MM-DD). Days may be missing — treated as zero.
 * @param {string[]} window list of YYYY-MM-DD dates
 */
export function aggregateWindow(results, window) {
  let pnl = 0;
  let wins = 0;
  let losses = 0;
  let trades = 0;
  let covered = 0;
  for (const d of window) {
    const r = results[d];
    if (!r || !r.summary) continue;
    covered++;
    pnl += Number(r.summary.totalPnl || 0);
    wins += Number(r.summary.wins || 0);
    losses += Number(r.summary.losses || 0);
    trades += Number(r.summary.wins || 0) + Number(r.summary.losses || 0);
  }
  const wr = trades > 0 ? (wins / trades) * 100 : 0;
  return { pnl, wins, losses, trades, wr, covered, total: window.length };
}

/**
 * Bucket raw per-day records (as produced by runParallel) into a map keyed by
 * date for fast lookup during windowed aggregation. Failed / partial days
 * still appear (without a summary) so callers can tell "ran but no data"
 * apart from "never ran at all".
 * @param {Array<{date:string, status:string, summary?:object}>} records
 */
export function bucketResults(records) {
  const out = {};
  for (const r of records) {
    if (!r || !r.date) continue;
    out[r.date] = r;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Worker orchestration
// ---------------------------------------------------------------------------

/** Build CLI argv for a single simulate-day worker. */
export function buildWorkerArgs(date, opts) {
  const a = [
    SIMULATE_SCRIPT,
    opts.timeframe || '1m',
    '--date', date,
    '--index', opts.index,
    '--engine', opts.engine,
    '--confidence', String(opts.confidence),
    '--max-positions', String(opts.maxPositions),
    '--position-size', String(opts.positionSize),
    '--max-trades', String(opts.maxTrades),
  ];
  if (opts.pessimisticFills) a.push('--pessimistic-fills');
  else a.push('--no-pessimistic-fills');
  // Explicitly pass both variants so the child doesn't silently fall back
  // to simulate-day.mjs's default when the walk-forward user passed the
  // negated form. (Pre-Wave-2a this branch only appended the ON flag, which
  // was correct when the sim default was OFF; the default flipped to ON.)
  if (opts.regimeAwareStops) a.push('--regime-stops');
  else a.push('--no-regime-stops');
  if (opts.sizeTiers) a.push('--size-tiers', opts.sizeTiers);
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

/**
 * Run one simulate-day worker. Returns a per-day record.
 * Never throws for worker failures — encodes the failure in the result.
 * @param {string} date
 * @param {object} opts
 * @param {Set<import('node:child_process').ChildProcess>} livePool mutated set
 *   tracking still-running children (for Ctrl+C kill).
 */
function runOne(date, opts, livePool) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const args = buildWorkerArgs(date, opts);
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
        resolve({ date, status: 'killed', reason: `signal ${signal}`, wallMs });
        return;
      }
      if (code !== 0) {
        process.stderr.write(
          `[walk-forward] ${date} worker exited ${code}\n--- last stdout lines ---\n${tailLines(stdout, 20)}\n--- stderr ---\n${tailLines(stderr, 10)}\n\n`,
        );
        resolve({
          date,
          status: 'failed',
          reason: `exit ${code}`,
          wallMs,
          stdoutTail: tailLines(stdout, 20),
        });
        return;
      }
      // Success — try to read the trades file.
      const trades = readTradesFile(date);
      if (!trades) {
        process.stderr.write(
          `[walk-forward] ${date} worker succeeded but cache/trades/${date}.json is missing (partial-success — skipping aggregation)\n`,
        );
        resolve({ date, status: 'partial', reason: 'no trades file', wallMs });
        return;
      }
      resolve({
        date,
        status: 'ok',
        wallMs,
        runMeta: trades.runMeta || null,
        summary: trades.summary || null,
        trades: Array.isArray(trades.trades) ? trades.trades.length : 0,
      });
    });
  });
}

/**
 * Run a queue of dates with a fixed concurrency ceiling.
 * Simple semaphore: maintain up to `limit` in-flight workers.
 * @param {string[]} dates
 * @param {object} opts
 * @param {Set<import('node:child_process').ChildProcess>} livePool
 */
async function runParallel(dates, opts, livePool) {
  const limit = Math.max(1, opts.concurrency | 0);
  const results = [];
  let cursor = 0;
  let active = 0;
  process.stdout.write(`[walk-forward] spawning up to ${limit} concurrent workers for ${dates.length} day(s)\n`);
  return new Promise((resolve) => {
    const launchNext = () => {
      if (cursor >= dates.length && active === 0) {
        resolve(results);
        return;
      }
      while (active < limit && cursor < dates.length) {
        const date = dates[cursor++];
        active++;
        process.stdout.write(`[walk-forward] -> start ${date} (active ${active}/${limit})\n`);
        runOne(date, opts, livePool).then((rec) => {
          results.push(rec);
          active--;
          process.stdout.write(
            `[walk-forward] <- done  ${date} status=${rec.status} ` +
            `pnl=${rec.summary?.totalPnl ?? 'n/a'} wall=${(rec.wallMs / 1000).toFixed(1)}s ` +
            `(active ${active}/${limit})\n`,
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

function fmtInt(n) { return Number.isFinite(n) ? Math.round(n).toLocaleString('en-IN') : '-'; }
function fmtPct(n) { return Number.isFinite(n) ? `${n.toFixed(1)}%` : '-'; }

function renderPerDayTable(records) {
  const rows = [...records].sort((a, b) => a.date.localeCompare(b.date));
  const out = [];
  out.push('## Per-day results');
  out.push('');
  out.push('| Date | Status | Trades | Wins | Losses | P&L | Wall-time (s) |');
  out.push('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const r of rows) {
    const s = r.summary || {};
    const trades = (s.wins || 0) + (s.losses || 0);
    out.push(
      `| ${r.date} | ${r.status} | ${r.status === 'ok' ? trades : '-'} | ` +
      `${r.status === 'ok' ? (s.wins ?? 0) : '-'} | ` +
      `${r.status === 'ok' ? (s.losses ?? 0) : '-'} | ` +
      `${r.status === 'ok' ? fmtInt(s.totalPnl) : '-'} | ` +
      `${(r.wallMs / 1000).toFixed(1)} |`,
    );
  }
  return out.join('\n');
}

function renderWindowTable(windows, resultsByDate) {
  const out = [];
  out.push('## Walk-forward summary');
  out.push('');
  out.push('| Window | Train range | Test range | Train P&L (in-sample) | Test P&L (out-of-sample) | Test WR% |');
  out.push('| ---: | --- | --- | ---: | ---: | ---: |');
  for (const w of windows) {
    const tr = aggregateWindow(resultsByDate, w.train);
    const te = aggregateWindow(resultsByDate, w.test);
    const trainLbl = w.train.length ? `${w.train[0]} .. ${w.train.at(-1)}` : '-';
    const testLbl = w.test.length ? `${w.test[0]} .. ${w.test.at(-1)}` : '-';
    out.push(
      `| ${w.idx} | ${trainLbl} | ${testLbl} | ${fmtInt(tr.pnl)} | ${fmtInt(te.pnl)} | ${fmtPct(te.wr)} |`,
    );
  }
  return out.join('\n');
}

/**
 * Compute overall out-of-sample mean daily P&L, profit factor, and max drawdown
 * across the *union* of all test slices (unique days). Uses sequential daily
 * P&L in date order for drawdown.
 */
function computeFooterStats(windows, resultsByDate) {
  const testDays = new Set();
  for (const w of windows) for (const d of w.test) testDays.add(d);
  const sorted = [...testDays].sort();
  let gross = 0;
  let loss = 0;
  let win = 0;
  let peak = 0;
  let running = 0;
  let maxDd = 0;
  let covered = 0;
  for (const d of sorted) {
    const r = resultsByDate[d];
    if (!r || !r.summary) continue;
    covered++;
    const p = Number(r.summary.totalPnl || 0);
    gross += p;
    if (p >= 0) win += p; else loss += Math.abs(p);
    running += p;
    peak = Math.max(peak, running);
    const dd = peak - running;
    if (dd > maxDd) maxDd = dd;
  }
  const mean = covered > 0 ? gross / covered : 0;
  const pf = loss > 0 ? win / loss : (win > 0 ? Infinity : 0);
  return { mean, pf, maxDd, covered, sumPnl: gross };
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

  // Enumerate trading days from the NIFTY 1m cache (source of truth).
  const allDates = listCachedDates('^NSEI', '1m');
  const days = enumerateTradingDays(opts.from, opts.to, allDates);
  if (days.length < opts.trainDays + opts.testDays) {
    process.stderr.write(
      `[walk-forward] not enough trading days in [${opts.from}, ${opts.to}]: got ${days.length}, ` +
      `need at least trainDays(${opts.trainDays}) + testDays(${opts.testDays}) = ${opts.trainDays + opts.testDays}.\n` +
      `Hint: warm the chart cache first (npm run cache:charts) or widen --from/--to.\n`,
    );
    process.exit(1);
  }

  // Rolling windows (train is a placeholder for now — future PRs can inject
  // per-window threshold overrides here before running the test slice).
  // TODO(walk-forward): when we add per-window parameter search, use the
  // train slice to optimize (e.g. grid-sweep confidence) and inject the
  // winning params into the test-slice worker argv. For now train is
  // reported purely for in-sample comparison.
  const windows = buildWindows(days, opts.trainDays, opts.testDays, opts.stride);

  // Ensure output dir exists.
  fs.mkdirSync(WF_OUT_DIR, { recursive: true });

  // Run all days in parallel, respecting concurrency cap.
  const livePool = new Set();
  const sweepStart = Date.now();

  // Ctrl+C handler — kill children, dump partial results, exit 130.
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    process.stderr.write('\n[walk-forward] received SIGINT — killing workers\n');
    for (const c of livePool) {
      try { c.kill('SIGTERM'); } catch { /* noop */ }
    }
    // Give children a brief moment, then hard exit.
    setTimeout(() => {
      process.stderr.write('[walk-forward] exiting 130 (partial results discarded)\n');
      process.exit(130);
    }, 300).unref();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const records = await runParallel(days, opts, livePool);
  const wallMs = Date.now() - sweepStart;
  const resultsByDate = bucketResults(records);

  // Reports.
  process.stdout.write('\n' + renderPerDayTable(records) + '\n\n');
  process.stdout.write(renderWindowTable(windows, resultsByDate) + '\n\n');
  const footer = computeFooterStats(windows, resultsByDate);
  process.stdout.write(
    `**Aggregate (out-of-sample, unique test days covered: ${footer.covered})**  \n` +
    `- sum P&L: Rs ${fmtInt(footer.sumPnl)}\n` +
    `- mean daily P&L: Rs ${fmtInt(footer.mean)}\n` +
    `- profit factor: ${Number.isFinite(footer.pf) ? footer.pf.toFixed(2) : (footer.pf === Infinity ? 'inf' : '-')}\n` +
    `- max drawdown: Rs ${fmtInt(footer.maxDd)}\n` +
    `- total wall-clock: ${(wallMs / 1000).toFixed(1)}s\n`,
  );

  // Persist artifact.
  const runId = `wf-${Date.now()}`;
  const artifact = {
    runId,
    generatedAt: new Date().toISOString(),
    opts,
    days,
    windows,
    records,
    footer,
    wallMs,
  };
  const outPath = path.join(WF_OUT_DIR, `${runId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');
  process.stdout.write(`\n[walk-forward] artifact: ${outPath}\n`);

  const failed = records.filter((r) => r.status !== 'ok').length;
  process.exit(failed > 0 && records.filter((r) => r.status === 'ok').length === 0 ? 1 : 0);
}

// Only run main when invoked as a script, not when imported by tests.
const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[walk-forward] fatal: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
