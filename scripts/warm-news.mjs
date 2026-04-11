#!/usr/bin/env node
/**
 * Warm the news sentiment cache for a given date.
 *
 * Usage:
 *   node scripts/warm-news.mjs                      # today, Moneycontrol
 *   node scripts/warm-news.mjs --date 2026-04-10    # specific date
 *   node scripts/warm-news.mjs --source both        # MC + Google per-symbol
 *   node scripts/warm-news.mjs --source google      # Google only
 *
 * Writes: cache/news/<YYYY-MM-DD>.json  (symbol → score in [-1, +1])
 *
 * Note: this fetches CURRENT news from the RSS feeds. "Historical" news
 * sentiment for a past date isn't actually available — this script is
 * meant to be run at the start of a trading day to populate the day's
 * news map, which the sim then reads. For backtesting a past date you
 * would need a historical news dataset (not shipped).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildNewsSentimentMap } from '../src/engine/newsSentiment.js';
import { fetchNseIndexSymbolsNode } from './lib/nse-http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const NEWS_DIR = path.join(REPO_ROOT, 'cache', 'news');

function parseArgs() {
  const args = process.argv.slice(2);
  let date = new Date().toISOString().slice(0, 10);
  let source = 'moneycontrol';
  let index = 'NIFTY TOTAL MARKET';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) { date = args[++i]; continue; }
    if (args[i] === '--source' && args[i + 1]) { source = args[++i]; continue; }
    if (args[i] === '--index' && args[i + 1]) { index = args[++i]; continue; }
  }
  return { date, source, index };
}

async function main() {
  const { date, source, index } = parseArgs();

  console.log(`── News warm: ${date} | source=${source} | universe=${index}`);

  // Load symbol universe from NSE
  let symbols = [];
  try {
    symbols = await fetchNseIndexSymbolsNode(index);
  } catch (e) {
    console.error(`Failed to fetch ${index} constituents: ${e.message}`);
    console.error('Falling back to NIFTY 500');
    try {
      symbols = await fetchNseIndexSymbolsNode('NIFTY 500');
    } catch (e2) {
      console.error(`Also failed: ${e2.message}`);
      process.exit(1);
    }
  }
  console.log(`Loaded ${symbols.length} symbols from ${index}`);

  const universe = new Set(symbols.map((s) => String(s).toUpperCase()));

  // Fetch sentiment
  console.log(`Fetching news from ${source}...`);
  const started = Date.now();
  const map = await buildNewsSentimentMap(universe, { mode: source });
  const elapsed = Date.now() - started;

  const scoredCount = Object.keys(map).length;
  console.log(`Got sentiment for ${scoredCount}/${symbols.length} symbols in ${elapsed}ms`);

  if (scoredCount === 0) {
    console.log('No symbols scored — not writing cache file.');
    return;
  }

  // Distribution
  const pos = Object.values(map).filter((s) => s > 0.2).length;
  const neg = Object.values(map).filter((s) => s < -0.2).length;
  const mid = scoredCount - pos - neg;
  console.log(`Distribution: ${pos} bullish (>0.2), ${mid} neutral, ${neg} bearish (<-0.2)`);

  // Show top 5 bullish and top 5 bearish
  const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]);
  console.log('\nTop bullish:');
  for (const [sym, score] of sorted.slice(0, 5)) {
    console.log(`  ${sym.padEnd(16)} ${score.toFixed(3)}`);
  }
  console.log('Top bearish:');
  for (const [sym, score] of sorted.slice(-5).reverse()) {
    console.log(`  ${sym.padEnd(16)} ${score.toFixed(3)}`);
  }

  // Write cache
  fs.mkdirSync(NEWS_DIR, { recursive: true });
  const outPath = path.join(NEWS_DIR, `${date}.json`);
  fs.writeFileSync(outPath, JSON.stringify(map, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
