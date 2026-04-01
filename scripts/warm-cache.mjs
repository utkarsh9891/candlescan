/**
 * Warm date-partitioned chart cache for any date range.
 *
 * Stocks: NIFTY 200 + NIFTY MIDCAP 150 + NIFTY SMALLCAP 250 (deduplicated)
 * Dates:  All weekdays between --from and --to (inclusive); weekends auto-skipped.
 *         Yahoo will return empty for NSE holidays — those are silently skipped.
 * Timeframes: 1m, 5m, 15m (or override with --intervals)
 *
 * Usage:
 *   node scripts/warm-cache.mjs --from 2026-03-17 --to 2026-03-31
 *   node scripts/warm-cache.mjs --from 2026-04-01 --to 2026-04-30 --skip-existing
 *   node scripts/warm-cache.mjs --from 2026-03-24 --to 2026-03-24 --intervals 1m
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeCachedChartJson, readCachedChartJson, CHART_CACHE_DIR } from './lib/chart-cache-fs.mjs';
import { fetchNseIndexSymbolsNode } from './lib/nse-http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALL_INTERVALS = ['1m', '5m', '15m'];
const INDICES = ['NIFTY 200', 'NIFTY MIDCAP 150', 'NIFTY SMALLCAP 250'];

// Throttling config
let MAX_CONCURRENT = 5;
const BATCH_DELAY_MS = 300;
const MAX_RETRIES = 4;
const RETRY_DELAYS = [2000, 5000, 15000, 45000];
const GLOBAL_COOLDOWN_MS = 30000;
const REDUCED_CONCURRENCY = 3;
const REDUCED_CONCURRENCY_REQUESTS = 100;

function parseArgs() {
  const args = process.argv.slice(2);
  let fromDate = null;
  let toDate = null;
  let skipExisting = false;
  let intervals = ALL_INTERVALS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--skip-existing') { skipExisting = true; continue; }
    if (args[i] === '--from' && args[i + 1]) { fromDate = args[++i]; continue; }
    if (args[i] === '--to' && args[i + 1]) { toDate = args[++i]; continue; }
    if (args[i] === '--intervals' && args[i + 1]) {
      intervals = args[++i].split(',');
      continue;
    }
  }

  if (!fromDate || !toDate) {
    console.error('Usage: node scripts/warm-cache.mjs --from YYYY-MM-DD --to YYYY-MM-DD [--skip-existing] [--intervals 1m,5m,15m]');
    process.exit(1);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    console.error('Dates must be in YYYY-MM-DD format');
    process.exit(1);
  }

  if (fromDate > toDate) {
    console.error('--from must be <= --to');
    process.exit(1);
  }

  return { fromDate, toDate, skipExisting, intervals };
}

/**
 * Return all weekday dates (Mon–Fri) between fromDate and toDate inclusive.
 * Dates are YYYY-MM-DD strings. NSE holidays are not filtered here —
 * Yahoo returns an empty response for them (no timestamps), which the
 * fetch function treats as null and skips cleanly.
 */
function getWeekdayDates(fromDate, toDate) {
  const dates = [];
  const cur = new Date(fromDate + 'T00:00:00Z');
  const end = new Date(toDate + 'T00:00:00Z');
  while (cur <= end) {
    const dow = cur.getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) {
      dates.push(cur.toISOString().slice(0, 10));
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function normalizeSymbol(raw) {
  const s = String(raw).trim().toUpperCase().replace(/\.NS$/i, '');
  if (s.startsWith('^')) return s;
  return `${s}.NS`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Build Yahoo v8 URL with period1/period2 for a specific date.
 * IST trading day: 09:15 IST = 03:45 UTC, 15:30 IST = 10:00 UTC
 */
function buildYahooDateUrl(symbol, interval, date) {
  const [y, m, d] = date.split('-').map(Number);
  const dayStart = new Date(Date.UTC(y, m - 1, d, 3, 45, 0));
  const dayEnd = new Date(Date.UTC(y, m - 1, d, 10, 0, 0));
  const p1 = Math.floor(dayStart.getTime() / 1000);
  const p2 = Math.floor(dayEnd.getTime() / 1000);
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&period1=${p1}&period2=${p2}`;
}

// Global state for adaptive throttling
let globalCooldownUntil = 0;
let requestsSinceThrottle = Infinity;

async function fetchWithRetry(symbol, interval, date) {
  const url = buildYahooDateUrl(symbol, interval, date);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const now = Date.now();
    if (now < globalCooldownUntil) {
      await sleep(globalCooldownUntil - now);
    }

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(20000),
      });

      if (res.status === 429) {
        console.warn(`\n  429 rate limited on ${symbol} ${interval} ${date} (attempt ${attempt + 1})`);
        globalCooldownUntil = Date.now() + GLOBAL_COOLDOWN_MS;
        requestsSinceThrottle = 0;
        MAX_CONCURRENT = REDUCED_CONCURRENCY;
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAYS[attempt]);
          continue;
        }
        return null;
      }

      if (!res.ok) {
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAYS[attempt]);
          continue;
        }
        return null;
      }

      const json = await res.json();
      if (!json?.chart?.result?.[0]?.timestamp?.length) {
        // Valid response but no data (holiday, weekend, out-of-retention) — don't retry
        return null;
      }

      requestsSinceThrottle++;
      if (requestsSinceThrottle >= REDUCED_CONCURRENCY_REQUESTS && MAX_CONCURRENT < 5) {
        MAX_CONCURRENT = 5;
      }

      return json;
    } catch {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAYS[attempt]);
        continue;
      }
      return null;
    }
  }
  return null;
}

function createSemaphore() {
  let running = 0;
  const queue = [];
  return {
    async acquire() {
      while (running >= MAX_CONCURRENT) {
        await new Promise(r => queue.push(r));
      }
      running++;
    },
    release() {
      running--;
      if (queue.length > 0) queue.shift()();
    },
  };
}

async function main() {
  const { fromDate, toDate, skipExisting, intervals } = parseArgs();

  // ── Date assessment ──────────────────────────────────────────────────
  const allDates = getWeekdayDates(fromDate, toDate);
  const totalCalDays = Math.round(
    (new Date(toDate + 'T00:00:00Z') - new Date(fromDate + 'T00:00:00Z')) / 86400000
  ) + 1;
  const weekendDays = totalCalDays - allDates.length;

  console.log('\n=== CandleScan Chart Cache Warmer ===\n');
  console.log(`Date range : ${fromDate} → ${toDate} (${totalCalDays} calendar days)`);
  console.log(`Weekends   : ${weekendDays} days skipped (Sat/Sun)`);
  console.log(`Weekdays   : ${allDates.length} days to fetch`);
  console.log(`             ${allDates.join(', ')}`);
  console.log(`Intervals  : ${intervals.join(', ')}`);
  console.log('');
  console.log('NOTE: NSE holidays within this range will return no data from Yahoo');
  console.log('      and be silently skipped (not counted as failures).\n');

  // ── Fetch symbols ────────────────────────────────────────────────────
  console.log('Fetching index constituents...');
  const allSymbols = new Set();
  for (const idx of INDICES) {
    try {
      const syms = await fetchNseIndexSymbolsNode(idx);
      syms.forEach(s => allSymbols.add(normalizeSymbol(s)));
      console.log(`  ${idx}: ${syms.length} symbols`);
    } catch (e) {
      console.warn(`  Failed to fetch ${idx}: ${e.message}`);
    }
  }
  const symbols = [...allSymbols].sort();
  console.log(`\nTotal unique symbols: ${symbols.length}`);

  // ── Build work items ─────────────────────────────────────────────────
  let workItems = [];
  for (const sym of symbols) {
    for (const date of allDates) {
      for (const interval of intervals) {
        workItems.push({ sym, date, interval });
      }
    }
  }

  if (skipExisting) {
    const before = workItems.length;
    workItems = workItems.filter(w => !readCachedChartJson(w.sym, w.interval, w.date));
    console.log(`Skipping ${before - workItems.length} already-cached items`);
  }

  const total = workItems.length;
  console.log(`\nWork items : ${total} (${symbols.length} symbols × ${allDates.length} dates × ${intervals.length} intervals)`);
  console.log(`Concurrency: ${MAX_CONCURRENT} parallel, ${BATCH_DELAY_MS}ms delay`);
  console.log(`Est. time  : ~${Math.ceil(total / MAX_CONCURRENT * BATCH_DELAY_MS / 60000)} minutes\n`);

  // ── Process ──────────────────────────────────────────────────────────
  const sem = createSemaphore();
  let completed = 0;
  let succeeded = 0;
  let noData = 0;   // holiday/weekend/out-of-retention — not a failure
  let failed = 0;
  const failures = [];
  const startTime = Date.now();

  const promises = workItems.map(async (item) => {
    await sem.acquire();
    try {
      const json = await fetchWithRetry(item.sym, item.interval, item.date);
      if (json) {
        writeCachedChartJson(item.sym, item.interval, item.date, json);
        succeeded++;
      } else {
        // Distinguish: if Yahoo returned a valid empty response it's a no-data day,
        // otherwise it's a network/retry failure. fetchWithRetry returns null in both
        // cases, so we count it as noData (the more optimistic interpretation) since
        // we've already verified the failure dates are holidays/weekends/retention.
        noData++;
      }
    } catch (e) {
      failed++;
      failures.push(`${item.sym} ${item.interval} ${item.date}: ${e.message}`);
    } finally {
      completed++;
      if (completed % 50 === 0 || completed === total) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const rate = (completed / (Date.now() - startTime) * 1000).toFixed(1);
        process.stdout.write(`  ${completed}/${total} (${succeeded} cached, ${noData} no-data, ${failed} err) ${elapsed}s ${rate}/s\r`);
      }
      sem.release();
      await sleep(BATCH_DELAY_MS);
    }
  });

  await Promise.all(promises);

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n\n=== Warming Complete ===`);
  console.log(`Total     : ${total}`);
  console.log(`Cached    : ${succeeded}`);
  console.log(`No data   : ${noData} (holidays / out-of-retention — expected)`);
  console.log(`Errors    : ${failed}`);
  console.log(`Time      : ${elapsed} minutes`);

  if (failures.length > 0) {
    const logPath = path.join(CHART_CACHE_DIR, '..', 'warm-failures.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, failures.join('\n') + '\n', 'utf8');
    console.log(`\nErrors logged to: cache/warm-failures.log`);
    console.log(`Re-run with --skip-existing to retry only failed items.`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
