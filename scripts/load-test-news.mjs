#!/usr/bin/env node
/**
 * Load test for the CF Worker `/news/google?symbol=` endpoint.
 *
 * This is the per-symbol news RSS proxy that `src/engine/batchScan.js`
 * (PR #184) now calls PER CANDIDATE, behind a 6-wide semaphore and a
 * 1-hour per-(symbol,hour) cache. The concern motivating this script:
 * on an aggressive scan day (~5 scans × ~40 candidates) we could fire
 * ~200 fetches/day into the Worker's rate-limit budget. This tool lets
 * us measure real-world latency + error rate + headroom so we can catch
 * degradation before it silently kills scan quality.
 *
 * Usage:
 *   node scripts/load-test-news.mjs                                # defaults: 200 req / 6 concurrent
 *   node scripts/load-test-news.mjs --total 50 --concurrency 6
 *   node scripts/load-test-news.mjs --symbols "RELIANCE,TCS,INFY"
 *   node scripts/load-test-news.mjs --worker-url https://candlescan-proxy.utkarsh-dev.workers.dev
 *
 * Example: node scripts/load-test-news.mjs --total 200 --concurrency 6
 *
 * Exits 0 if success rate >= 95% AND p95 latency <= 3000ms; else 1.
 * Full per-request log is written to cache/load-test/news-<timestamp>.json.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';

import { CF_WORKER_URL } from '../src/engine/transport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(REPO_ROOT, 'cache', 'load-test');

// ─────────────────────────────────────────────────────────────────────
// Default symbol pool — 20 liquid NIFTY 50 constituents. Cycled through
// when the caller doesn't pass --symbols. Picked to spread requests
// across unrelated news queries so we don't hammer a single cache key
// on the Worker / Google RSS side.
// ─────────────────────────────────────────────────────────────────────
const DEFAULT_NIFTY50_SAMPLE = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
  'HINDUNILVR', 'SBIN', 'BHARTIARTL', 'ITC', 'KOTAKBANK',
  'LT', 'AXISBANK', 'ASIANPAINT', 'MARUTI', 'HCLTECH',
  'SUNPHARMA', 'WIPRO', 'TATAMOTORS', 'NESTLEIND', 'BAJFINANCE',
];

const DEFAULTS = {
  concurrency: 6,
  total: 200,
  symbols: null,
  workerUrl: CF_WORKER_URL,
  timeoutMs: 15000,
};

function printHelpAndExit(code = 0) {
  const help = `
Load test for the CF Worker /news/google endpoint.

Usage:
  node scripts/load-test-news.mjs [options]

Options:
  --concurrency N       simultaneous requests (default: 6, matches batchScan)
  --total N             total requests to send (default: 200)
  --symbols "A,B,C"     specific symbols to cycle through
                        (default: sample 20 from NIFTY 50)
  --worker-url URL      override default worker URL
                        (default: ${CF_WORKER_URL})
  --timeout MS          per-request timeout in ms (default: 15000)
  -h, --help            show this help

Example: node scripts/load-test-news.mjs --total 200 --concurrency 6

Exit codes:
  0  success rate >= 95% AND p95 latency <= 3000ms
  1  otherwise
`;
  console.log(help.trim());
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') printHelpAndExit(0);
    else if (a === '--concurrency' && args[i + 1]) opts.concurrency = Math.max(1, parseInt(args[++i], 10) || 1);
    else if (a === '--total' && args[i + 1]) opts.total = Math.max(1, parseInt(args[++i], 10) || 1);
    else if (a === '--symbols' && args[i + 1]) opts.symbols = args[++i].split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--worker-url' && args[i + 1]) opts.workerUrl = args[++i].replace(/\/+$/, '');
    else if (a === '--timeout' && args[i + 1]) opts.timeoutMs = Math.max(1000, parseInt(args[++i], 10) || 15000);
    else {
      console.error(`Unknown argument: ${a}`);
      printHelpAndExit(1);
    }
  }
  if (!opts.symbols || opts.symbols.length === 0) opts.symbols = [...DEFAULT_NIFTY50_SAMPLE];
  return opts;
}

// ─────────────────────────────────────────────────────────────────────
// Single request. Returns a plain result record (never throws).
// ─────────────────────────────────────────────────────────────────────
async function runOne(i, symbol, { workerUrl, timeoutMs }) {
  const url = `${workerUrl}/news/google?symbol=${encodeURIComponent(symbol)}`;
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let status = 0;
  let ok = false;
  let timedOut = false;
  let error = null;
  let bytes = 0;
  let cacheHint = null;
  let rateRemaining = null;
  let itemCount = null;
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
    status = res.status;
    ok = res.ok;
    // Headers that may help infer cache / rate-limit behaviour. The
    // Worker doesn't currently set x-cache or x-ratelimit-remaining but
    // CF's edge cache may surface cf-cache-status — capture whichever
    // shows up so future Worker additions are picked up automatically.
    cacheHint = res.headers.get('x-cache')
      || res.headers.get('cf-cache-status')
      || res.headers.get('x-cache-status')
      || null;
    rateRemaining = res.headers.get('x-ratelimit-remaining')
      || res.headers.get('ratelimit-remaining')
      || null;
    const text = await res.text();
    bytes = text.length;
    try {
      const json = JSON.parse(text);
      if (json && typeof json.count === 'number') itemCount = json.count;
      else if (Array.isArray(json?.items)) itemCount = json.items.length;
    } catch {
      // Non-JSON body — leave itemCount null.
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      timedOut = true;
      error = `timeout after ${timeoutMs}ms`;
    } else {
      error = String(err?.message || err);
    }
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = performance.now() - started;
  return {
    i,
    symbol,
    startedAt,
    status,
    ok,
    timedOut,
    error,
    latencyMs: Math.round(latencyMs),
    bytes,
    cacheHint,
    rateRemaining: rateRemaining != null ? Number(rateRemaining) : null,
    itemCount,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Run `total` requests, capped at `concurrency` in flight. Cycles
// through the symbol list round-robin. Logs per-request outcome.
// ─────────────────────────────────────────────────────────────────────
async function runAll(opts) {
  const { total, concurrency, symbols } = opts;
  const results = new Array(total);
  let next = 0;
  let done = 0;
  async function worker(workerId) {
    while (true) {
      const i = next++;
      if (i >= total) return;
      const sym = symbols[i % symbols.length];
      const r = await runOne(i, sym, opts);
      results[i] = r;
      done++;
      const status = r.ok ? 'OK' : (r.timedOut ? 'TIMEOUT' : `HTTP ${r.status || 'ERR'}`);
      const cache = r.cacheHint ? ` cache=${r.cacheHint}` : '';
      const items = r.itemCount != null ? ` items=${r.itemCount}` : '';
      const err = r.error ? ` err="${r.error}"` : '';
      console.log(
        `[${String(done).padStart(String(total).length)}/${total}] `
        + `w${workerId} ${r.symbol.padEnd(12)} ${status.padEnd(10)} `
        + `${String(r.latencyMs).padStart(5)}ms ${String(r.bytes).padStart(6)}B${items}${cache}${err}`,
      );
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, total) }, (_, id) => worker(id));
  await Promise.all(workers);
  return results;
}

// ─────────────────────────────────────────────────────────────────────
// Exported so tests can pin down the aggregation logic without having
// to stand up a Worker. Accepts the raw results array from runAll.
// ─────────────────────────────────────────────────────────────────────
export function summarize(results) {
  const total = results.length;
  const success = results.filter((r) => r.ok).length;
  const c4xx = results.filter((r) => r.status >= 400 && r.status < 500).length;
  const c5xx = results.filter((r) => r.status >= 500 && r.status < 600).length;
  const timeouts = results.filter((r) => r.timedOut).length;
  const networkErrors = results.filter((r) => !r.ok && r.status === 0 && !r.timedOut).length;
  const latencies = results.map((r) => r.latencyMs).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const pct = (p) => {
    if (latencies.length === 0) return 0;
    const idx = Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length));
    return latencies[idx];
  };
  const p50 = pct(50);
  const p95 = pct(95);
  const p99 = pct(99);
  const max = latencies.length ? latencies[latencies.length - 1] : 0;
  const mean = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;
  const withCacheHint = results.filter((r) => r.cacheHint != null);
  // Count any positive cache signal: HIT / cf-cache-status=HIT / etc.
  const cacheHits = withCacheHint.filter((r) => /hit/i.test(String(r.cacheHint))).length;
  const cacheHitRate = withCacheHint.length
    ? cacheHits / withCacheHint.length
    : null;
  const withRate = results.filter((r) => typeof r.rateRemaining === 'number' && Number.isFinite(r.rateRemaining));
  const minRateRemaining = withRate.length
    ? Math.min(...withRate.map((r) => r.rateRemaining))
    : null;
  const totalBytes = results.reduce((a, r) => a + (r.bytes || 0), 0);
  const successRate = total > 0 ? success / total : 0;
  const pass = successRate >= 0.95 && p95 <= 3000;
  return {
    total,
    success,
    successRate,
    fail: total - success,
    status4xx: c4xx,
    status5xx: c5xx,
    timeouts,
    networkErrors,
    latency: { p50, p95, p99, max, mean },
    cacheSamples: withCacheHint.length,
    cacheHits,
    cacheHitRate,
    minRateRemaining,
    totalBytes,
    pass,
  };
}

function printSummary(s, opts, elapsedMs) {
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log('Load test summary');
  console.log(line);
  console.log(`Worker URL      : ${opts.workerUrl}`);
  console.log(`Total requests  : ${s.total}   (concurrency=${opts.concurrency})`);
  console.log(`Elapsed         : ${(elapsedMs / 1000).toFixed(2)}s`);
  console.log(`Throughput      : ${(s.total / (elapsedMs / 1000)).toFixed(2)} req/s`);
  console.log(line);
  console.log(`Success         : ${s.success}/${s.total} (${(s.successRate * 100).toFixed(1)}%)`);
  console.log(`4xx             : ${s.status4xx}`);
  console.log(`5xx             : ${s.status5xx}`);
  console.log(`Timeouts        : ${s.timeouts}`);
  console.log(`Network errors  : ${s.networkErrors}`);
  console.log(line);
  console.log(`Latency (ms)    : p50=${s.latency.p50}  p95=${s.latency.p95}  p99=${s.latency.p99}  max=${s.latency.max}  mean=${s.latency.mean}`);
  console.log(`Bytes           : ${s.totalBytes} total (${Math.round(s.totalBytes / Math.max(1, s.total))}B/req avg)`);
  console.log(line);
  if (s.cacheSamples > 0) {
    console.log(`Cache hits      : ${s.cacheHits}/${s.cacheSamples} (${((s.cacheHitRate || 0) * 100).toFixed(1)}%)`);
  } else {
    console.log('Cache hits      : no cache headers observed (Worker does not emit x-cache / cf-cache-status)');
  }
  if (s.minRateRemaining != null) {
    console.log(`Rate headroom   : min remaining = ${s.minRateRemaining} (from x-ratelimit-remaining)`);
  } else {
    console.log('Rate headroom   : no rate-limit header observed');
  }
  console.log(line);
  console.log(`Thresholds      : success >= 95% (${(s.successRate * 100).toFixed(1)}%)  p95 <= 3000ms (${s.latency.p95}ms)`);
  console.log(`Result          : ${s.pass ? 'PASS' : 'FAIL'}`);
  console.log(line);
}

async function main() {
  const opts = parseArgs(process.argv);
  console.log(`── News endpoint load test`);
  console.log(`  worker     : ${opts.workerUrl}`);
  console.log(`  total      : ${opts.total}`);
  console.log(`  concurrency: ${opts.concurrency}`);
  console.log(`  timeout    : ${opts.timeoutMs}ms`);
  console.log(`  symbols    : ${opts.symbols.length} (${opts.symbols.slice(0, 5).join(',')}${opts.symbols.length > 5 ? ',...' : ''})\n`);

  const startedAt = new Date();
  const t0 = performance.now();
  const results = await runAll(opts);
  const elapsedMs = performance.now() - t0;
  const summary = summarize(results);
  printSummary(summary, opts, elapsedMs);

  // Persist to disk so future scheduled runs can diff latency.
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(LOG_DIR, `news-${stamp}.json`);
  const payload = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs: Math.round(elapsedMs),
    opts: {
      workerUrl: opts.workerUrl,
      total: opts.total,
      concurrency: opts.concurrency,
      timeoutMs: opts.timeoutMs,
      symbols: opts.symbols,
    },
    summary,
    results,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${path.relative(REPO_ROOT, outPath)}`);

  process.exit(summary.pass ? 0 : 1);
}

// Only run when executed directly (not when imported by tests).
const invokedDirectly = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
