/**
 * Confidence -> Win-rate calibration analysis.
 *
 * Reads every `cache/trades/<YYYY-MM-DD>.json` file produced by the
 * simulator / walk-forward runs, buckets trades along five dimensions
 * (confidence, volFactor, rs, intraPct, vixRegime), and prints a
 * markdown table of win-rate / mean P&L / sum P&L / profit factor per
 * bucket. Also writes the full bucket data as JSON under
 * `cache/analysis/confidence_wr_<timestamp>.json`.
 *
 * Usage:
 *   node scripts/analyse-trades.mjs
 *   node scripts/analyse-trades.mjs --from 2026-03-12 --to 2026-04-10
 *   node scripts/analyse-trades.mjs --min-n 10
 *
 * Flags:
 *   --from YYYY-MM-DD   only include trade files on/after this date
 *   --to   YYYY-MM-DD   only include trade files on/before this date
 *   --min-n N           suppress buckets with fewer than N trades (default 5)
 *
 * The `bucketTrades(trades, dimension)` helper is exported so the unit
 * test can validate the maths without spinning up the whole pipeline.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const TRADES_DIR = join(REPO_ROOT, 'cache', 'trades');
const ANALYSIS_DIR = join(REPO_ROOT, 'cache', 'analysis');

/**
 * Bucket definitions. Each entry has:
 *   - label   : display name for the bucket
 *   - test(v) : returns true if a numeric value falls in this bucket
 * The buckets are applied in order; first match wins.
 * `null` / `undefined` values fall through to the "unknown" bucket.
 */
export const BUCKETS = {
  confidence: {
    extract: (t) => t?.confidence,
    bands: [
      { label: '70-74', test: (v) => v >= 70 && v < 75 },
      { label: '75-79', test: (v) => v >= 75 && v < 80 },
      { label: '80-84', test: (v) => v >= 80 && v < 85 },
      { label: '85-89', test: (v) => v >= 85 && v < 90 },
      { label: '90+',   test: (v) => v >= 90 },
    ],
  },
  volFactor: {
    extract: (t) => t?.features?.volFactor,
    bands: [
      { label: '<1.5',    test: (v) => v < 1.5 },
      { label: '1.5-2.0', test: (v) => v >= 1.5 && v < 2.0 },
      { label: '2.0-3.0', test: (v) => v >= 2.0 && v < 3.0 },
      { label: '3.0+',    test: (v) => v >= 3.0 },
    ],
  },
  rs: {
    extract: (t) => t?.features?.rs,
    bands: [
      { label: '<1.0',    test: (v) => v < 1.0 },
      { label: '1.0-1.5', test: (v) => v >= 1.0 && v < 1.5 },
      { label: '1.5-2.5', test: (v) => v >= 1.5 && v < 2.5 },
      { label: '2.5+',    test: (v) => v >= 2.5 },
    ],
  },
  intraPct: {
    extract: (t) => t?.features?.intraPct,
    bands: [
      { label: '<1.5',    test: (v) => v < 1.5 },
      { label: '1.5-2.0', test: (v) => v >= 1.5 && v < 2.0 },
      { label: '2.0-3.0', test: (v) => v >= 2.0 && v < 3.0 },
      { label: '3.0+',    test: (v) => v >= 3.0 },
    ],
  },
  vixRegime: {
    extract: (t) => t?.contextSnapshot?.vixRegime,
    // Categorical — use explicit equality checks; `unknown` catches the rest.
    bands: [
      { label: 'LOW',  test: (v) => v === 'LOW' },
      { label: 'MED',  test: (v) => v === 'MED' },
      { label: 'HIGH', test: (v) => v === 'HIGH' },
    ],
  },
};

/**
 * Classify a single trade into a bucket label for a given dimension.
 * Returns `'unknown'` for null / undefined / non-matching values so the
 * caller never has to special-case missing features.
 */
function classify(trade, dimension) {
  const def = BUCKETS[dimension];
  if (!def) throw new Error(`Unknown bucket dimension: ${dimension}`);
  const val = def.extract(trade);
  if (val === null || val === undefined) return 'unknown';
  if (typeof val === 'number' && Number.isNaN(val)) return 'unknown';
  for (const band of def.bands) {
    if (band.test(val)) return band.label;
  }
  return 'unknown';
}

/**
 * Aggregate trade stats for a single bucket.
 *   n         — trade count
 *   wins      — netPnl > 0
 *   losses    — netPnl <= 0  (zero P&L counts as a loss for PF)
 *   winRate   — wins / n     (0..1)
 *   meanPnl   — sum / n
 *   sumPnl    — cumulative netPnl
 *   profitFactor — sum(winPnl) / |sum(lossPnl)|, or Infinity if no losses
 */
function emptyBucket() {
  return { n: 0, wins: 0, losses: 0, sumPnl: 0, sumWinPnl: 0, sumLossPnl: 0 };
}

function finaliseBucket(b) {
  const winRate = b.n > 0 ? b.wins / b.n : 0;
  const meanPnl = b.n > 0 ? b.sumPnl / b.n : 0;
  const absLoss = Math.abs(b.sumLossPnl);
  const profitFactor = absLoss === 0
    ? (b.sumWinPnl > 0 ? Infinity : 0)
    : b.sumWinPnl / absLoss;
  return {
    n: b.n,
    wins: b.wins,
    losses: b.losses,
    winRate,
    meanPnl,
    sumPnl: b.sumPnl,
    profitFactor,
  };
}

/**
 * Public, unit-tested helper: bucket `trades` along `dimension` and return
 * a map of `{ label: stats }` where stats is the finalised shape above.
 * Pure function — no file I/O, no console output.
 */
export function bucketTrades(trades, dimension) {
  const buckets = {};
  for (const t of trades) {
    const label = classify(t, dimension);
    if (!buckets[label]) buckets[label] = emptyBucket();
    const b = buckets[label];
    const pnl = Number(t?.netPnl ?? 0);
    b.n += 1;
    b.sumPnl += pnl;
    if (pnl > 0) {
      b.wins += 1;
      b.sumWinPnl += pnl;
    } else {
      b.losses += 1;
      b.sumLossPnl += pnl;
    }
  }
  const out = {};
  for (const [label, raw] of Object.entries(buckets)) {
    out[label] = finaliseBucket(raw);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let from = null;
  let to = null;
  let minN = 5;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from' && argv[i + 1]) { from = argv[++i]; continue; }
    if (a === '--to' && argv[i + 1])   { to   = argv[++i]; continue; }
    if (a === '--min-n' && argv[i + 1]) { minN = Number(argv[++i]); continue; }
  }
  return { from, to, minN };
}

function listTradeFiles() {
  if (!existsSync(TRADES_DIR)) return [];
  return readdirSync(TRADES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(TRADES_DIR, f));
}

function inDateRange(dateStr, from, to) {
  if (!dateStr) return true; // missing date header — don't drop the file
  if (from && dateStr < from) return false;
  if (to && dateStr > to) return false;
  return true;
}

function loadTrades({ from, to }) {
  const files = listTradeFiles();
  const all = [];
  for (const f of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(f, 'utf8'));
    } catch (err) {
      console.warn(`  skip ${f}: ${err.message}`);
      continue;
    }
    const date = parsed?.date;
    if (!inDateRange(date, from, to)) continue;
    const trades = Array.isArray(parsed?.trades) ? parsed.trades : [];
    for (const t of trades) {
      all.push({ ...t, date: date ?? null });
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtPct(x) {
  return `${Math.round(x * 100)}%`;
}

function fmtRs(x) {
  // Indian-grouping-ish: keep it simple with thousands separators.
  const sign = x < 0 ? '-' : '';
  const n = Math.abs(Math.round(x));
  return `${sign}${n.toLocaleString('en-IN')}`;
}

function fmtPf(pf) {
  if (!Number.isFinite(pf)) return '∞';
  return pf.toFixed(2);
}

/**
 * Preferred ordering for known band labels — keeps the table
 * reading left-to-right as "low -> high". Unknown labels sort
 * alphabetically at the end.
 */
function bandOrder(dimension) {
  const def = BUCKETS[dimension];
  if (!def) return [];
  return def.bands.map((b) => b.label).concat(['unknown']);
}

function renderSection(title, stats, dimension, minN) {
  const order = bandOrder(dimension);
  const entries = Object.entries(stats);
  entries.sort(([a], [b]) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  const visible = entries.filter(([, s]) => s.n >= minN);
  const suppressed = entries.length - visible.length;

  const lines = [];
  lines.push(`### ${title}`);
  lines.push('');
  lines.push('| Bucket   | n    | Win% | Mean P&L | Sum P&L | PF    |');
  lines.push('|----------|------|------|----------|---------|-------|');
  if (visible.length === 0) {
    lines.push(`| _(all buckets filtered below min-n=${minN})_ |      |      |          |         |       |`);
  } else {
    for (const [label, s] of visible) {
      lines.push(
        `| ${label.padEnd(8)} | ${String(s.n).padEnd(4)} | ${fmtPct(s.winRate).padEnd(4)} `
        + `| Rs ${fmtRs(s.meanPnl).padEnd(5)} | ${fmtRs(s.sumPnl).padEnd(7)} | ${fmtPf(s.profitFactor).padEnd(5)} |`
      );
    }
  }
  if (suppressed > 0) {
    lines.push('');
    lines.push(`_${suppressed} bucket(s) filtered below min-n=${minN}_`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderSummary(trades) {
  let wins = 0, losses = 0, total = 0;
  for (const t of trades) {
    const pnl = Number(t?.netPnl ?? 0);
    total += pnl;
    if (pnl > 0) wins++;
    else losses++;
  }
  const n = trades.length;
  const wr = n > 0 ? wins / n : 0;
  // Mirror bucketTrades' PF convention so the headline matches the per-bucket
  // numbers readers can sum to it.
  let sumWin = 0, sumLoss = 0;
  for (const t of trades) {
    const pnl = Number(t?.netPnl ?? 0);
    if (pnl > 0) sumWin += pnl; else sumLoss += pnl;
  }
  const absLoss = Math.abs(sumLoss);
  const pf = absLoss === 0 ? (sumWin > 0 ? Infinity : 0) : sumWin / absLoss;

  return `Total trades: ${n}, Wins: ${wins}, Losses: ${losses}, Overall WR: ${fmtPct(wr)}, `
    + `Total P&L: Rs ${fmtRs(total)}, Profit factor: ${fmtPf(pf)}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { from, to, minN } = parseArgs(process.argv.slice(2));

  const files = listTradeFiles();
  if (files.length === 0) {
    console.log('No trade files found. Run simulate-day.mjs or walk-forward.mjs first.');
    process.exit(0);
  }

  const trades = loadTrades({ from, to });
  if (trades.length === 0) {
    console.log('No trade files found. Run simulate-day.mjs or walk-forward.mjs first.');
    process.exit(0);
  }

  console.log(renderSummary(trades));
  console.log('');

  const dimensions = [
    ['Confidence bands', 'confidence'],
    ['volFactor bands',  'volFactor'],
    ['rs bands',         'rs'],
    ['intraPct bands',   'intraPct'],
    ['VIX regime',       'vixRegime'],
  ];

  const fullReport = { generatedAt: Date.now(), filters: { from, to, minN }, summary: {}, buckets: {} };
  fullReport.summary = { totalTrades: trades.length };

  for (const [title, dim] of dimensions) {
    const stats = bucketTrades(trades, dim);
    fullReport.buckets[dim] = stats;
    console.log(renderSection(title, stats, dim, minN));
  }

  if (!existsSync(ANALYSIS_DIR)) mkdirSync(ANALYSIS_DIR, { recursive: true });
  const outPath = join(ANALYSIS_DIR, `confidence_wr_${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(fullReport, null, 2));
  console.log(`Wrote ${outPath}`);
}

// Only execute when invoked directly (not when imported from tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
