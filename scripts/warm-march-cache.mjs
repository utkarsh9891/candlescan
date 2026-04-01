/**
 * Warm date-partitioned chart cache for all March 2026 trading days.
 *
 * Stocks: NIFTY 200 + NIFTY MIDCAP 150 + NIFTY SMALLCAP 250 (deduplicated)
 * Dates:  Every trading day in March 2026 (Holi=Mar 14, weekends excluded)
 * Timeframes: 1m, 5m, 15m
 *
 * Usage:
 *   node scripts/warm-march-cache.mjs
 *   node scripts/warm-march-cache.mjs --skip-existing   # skip already-cached combos
 *   node scripts/warm-march-cache.mjs --dates 24,25,26  # warm specific dates only
 *   node scripts/warm-march-cache.mjs --intervals 1m    # warm specific interval only
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeCachedChartJson, readCachedChartJson, CHART_CACHE_DIR } from './lib/chart-cache-fs.mjs';
import { fetchNseIndexSymbolsNode } from './lib/nse-http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// March 2026 trading days (Holi = Mar 14, weekends excluded)
const ALL_MARCH_DAYS = [2,3,4,5,6,7,10,11,12,13,17,18,19,20,21,24,25,26,27,30,31];
const ALL_INTERVALS = ['1m', '5m', '15m'];
const INDICES = ['NIFTY 200', 'NIFTY MIDCAP 150', 'NIFTY SMALLCAP 250'];

// Throttling config
let MAX_CONCURRENT = 5;
let BATCH_DELAY_MS = 300;
const MAX_RETRIES = 4;
const RETRY_DELAYS = [2000, 5000, 15000, 45000];
const GLOBAL_COOLDOWN_MS = 30000;
const REDUCED_CONCURRENCY = 3;
const REDUCED_CONCURRENCY_REQUESTS = 100;

function parseArgs() {
  const args = process.argv.slice(2);
  let skipExisting = false;
  let dates = ALL_MARCH_DAYS;
  let intervals = ALL_INTERVALS;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--skip-existing') { skipExisting = true; continue; }
    if (args[i] === '--dates' && args[i + 1]) {
      dates = args[++i].split(',').map(Number);
      continue;
    }
    if (args[i] === '--intervals' && args[i + 1]) {
      intervals = args[++i].split(',');
      continue;
    }
  }
  return { skipExisting, dates, intervals };
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
    // Wait for global cooldown
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
        // Rate limited — apply global cooldown
        console.warn(`  429 rate limited on ${symbol} ${interval} ${date} (attempt ${attempt + 1})`);
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
        // Valid response but no data (holiday, no trading) — don't retry
        return null;
      }

      // Gradually restore concurrency
      requestsSinceThrottle++;
      if (requestsSinceThrottle >= REDUCED_CONCURRENCY_REQUESTS && MAX_CONCURRENT < 5) {
        MAX_CONCURRENT = 5;
      }

      return json;
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAYS[attempt]);
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * Simple semaphore for concurrency control.
 */
function createSemaphore(max) {
  let running = 0;
  const queue = [];
  return {
    async acquire() {
      while (running >= MAX_CONCURRENT) { // Use global MAX_CONCURRENT for adaptive throttling
        await new Promise(r => queue.push(r));
      }
      running++;
    },
    release() {
      running--;
      if (queue.length > 0) queue.shift()();
    }
  };
}

async function main() {
  const { skipExisting, dates, intervals } = parseArgs();

  console.log('\n=== CandleScan March 2026 Cache Warmer ===\n');

  // 1. Fetch symbols from all indices and deduplicate
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

  // 2. Build work items
  const dateStrings = dates.map(d => `2026-03-${String(d).padStart(2, '0')}`);
  let workItems = [];
  for (const sym of symbols) {
    for (const date of dateStrings) {
      for (const interval of intervals) {
        workItems.push({ sym, date, interval });
      }
    }
  }

  // Skip already cached if requested
  if (skipExisting) {
    const before = workItems.length;
    workItems = workItems.filter(w => !readCachedChartJson(w.sym, w.interval, w.date));
    console.log(`Skipping ${before - workItems.length} already-cached items`);
  }

  const total = workItems.length;
  console.log(`\nWork items: ${total} (${symbols.length} symbols × ${dateStrings.length} dates × ${intervals.length} intervals)`);
  console.log(`Estimated time: ${Math.ceil(total / MAX_CONCURRENT * BATCH_DELAY_MS / 60000)} minutes\n`);

  // 3. Process with semaphore
  const sem = createSemaphore(MAX_CONCURRENT);
  let completed = 0;
  let succeeded = 0;
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
        failed++;
        failures.push(`${item.sym} ${item.interval} ${item.date}`);
      }
    } catch (e) {
      failed++;
      failures.push(`${item.sym} ${item.interval} ${item.date}: ${e.message}`);
    } finally {
      completed++;
      if (completed % 50 === 0 || completed === total) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const rate = (completed / (Date.now() - startTime) * 1000).toFixed(1);
        process.stdout.write(`  ${completed}/${total} (${succeeded} ok, ${failed} fail) ${elapsed}s ${rate}/s\r`);
      }
      sem.release();
      // Small delay between requests to avoid bursting
      await sleep(BATCH_DELAY_MS);
    }
  });

  await Promise.all(promises);

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n\n=== Warming Complete ===`);
  console.log(`Total:     ${total}`);
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Failed:    ${failed}`);
  console.log(`Time:      ${elapsed} minutes`);

  // Write failures log
  if (failures.length > 0) {
    const logPath = path.join(CHART_CACHE_DIR, '..', 'warm-failures.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, failures.join('\n') + '\n', 'utf8');
    console.log(`\nFailures logged to: cache/warm-failures.log`);
    console.log(`Re-run with --skip-existing to retry only failed items.`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
