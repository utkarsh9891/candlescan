#!/usr/bin/env node
/**
 * Sector-map freshness checker (Phase A P2 #10).
 *
 * Compares src/engine/sectorMap.js (hardcoded ~208 NSE symbols → sector label)
 * against live NSE sector-index constituents and reports the diff. Exits 1 on
 * any drift so a CI job can wire this up later.
 *
 * Usage:
 *   node scripts/check-sector-map-freshness.mjs              # human-readable report
 *   node scripts/check-sector-map-freshness.mjs --json       # JSON-only output
 *   node scripts/check-sector-map-freshness.mjs --sector IT  # single sector
 *
 * Writes the JSON diff to cache/sector-map-diff/sector-diff-<timestamp>.json
 * for programmatic consumption.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STOCK_SECTOR } from '../src/engine/sectorMap.js';
import { diffSectorSets, fsTimestamp } from '../src/engine/sector-freshness.js';
import { fetchNseIndexSymbolsNode } from './lib/nse-http.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

/**
 * Sector label (as used in sectorMap.js) → NSE index name (exact query value
 * accepted by the equity-stockIndices endpoint).
 *
 * Labels must match the values present in STOCK_SECTOR. Do not invent labels —
 * the pipeline reads these directly and any drift here becomes silent bugs.
 */
const NSE_SECTOR_INDICES = {
  BANK: 'NIFTY BANK',
  FIN: 'NIFTY FIN SERVICE',
  IT: 'NIFTY IT',
  AUTO: 'NIFTY AUTO',
  FMCG: 'NIFTY FMCG',
  PHARMA: 'NIFTY PHARMA',
  METAL: 'NIFTY METAL',
  REALTY: 'NIFTY REALTY',
  ENERGY: 'NIFTY ENERGY',
  MEDIA: 'NIFTY MEDIA',
  INFRA: 'NIFTY INFRASTRUCTURE',
  PSE: 'NIFTY PSE',
  CONSUMER: 'NIFTY CONSUMER DURABLES',
};

function parseArgs(argv) {
  const args = { json: false, sector: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--sector' && argv[i + 1]) {
      args.sector = argv[i + 1].toUpperCase();
      i++;
    }
  }
  return args;
}

/**
 * Fetch constituents for every sector in the given label list. Network errors
 * per-sector are caught so one flaky index doesn't abort the whole run.
 *
 * @returns {Promise<{
 *   live: Record<string, string[]>,
 *   skipped: Array<{ sector: string, error: string }>,
 * }>}
 */
async function fetchLiveSectors(sectorLabels) {
  const live = {};
  const skipped = [];
  for (const sector of sectorLabels) {
    const indexName = NSE_SECTOR_INDICES[sector];
    if (!indexName) {
      skipped.push({ sector, error: `No NSE index mapping for label "${sector}"` });
      continue;
    }
    try {
      const syms = await fetchNseIndexSymbolsNode(indexName);
      live[sector] = syms;
    } catch (err) {
      skipped.push({ sector, error: err?.message || String(err) });
    }
  }
  return { live, skipped };
}

function formatReport(diff, skipped, asOfDate) {
  const lines = [];
  lines.push(`## Sector map freshness (as of ${asOfDate})`);
  lines.push('');

  const sectors = Object.keys(diff.perSector).sort();
  for (const sector of sectors) {
    const b = diff.perSector[sector];
    const parts = [`${b.upToDate.length} up-to-date`];
    if (b.missing.length) parts.push(`${b.missing.length} missing (${b.missing.join(', ')})`);
    if (b.stale.length) parts.push(`${b.stale.length} stale (${b.stale.join(', ')})`);
    if (b.mismatched.length) {
      const mm = b.mismatched.map((m) => `${m.symbol} [hardcoded=${m.hardcodedSector}]`).join(', ');
      parts.push(`${b.mismatched.length} mismatched (${mm})`);
    }
    lines.push(`- ${sector}: ${parts.join(', ')}`);
  }

  if (skipped.length) {
    lines.push('');
    lines.push('### Skipped sectors (network / API errors)');
    for (const s of skipped) lines.push(`- ${s.sector}: N/A (${s.error})`);
  }

  if (!diff.hasDrift) {
    lines.push('');
    lines.push('No drift detected. sectorMap.js is up-to-date with NSE indices.');
    return lines.join('\n');
  }

  // Suggested patch.
  lines.push('');
  lines.push('### Suggested patch');
  lines.push('');

  const toAdd = [];
  const toRemove = [];
  const toRelabel = [];
  for (const sector of sectors) {
    const b = diff.perSector[sector];
    for (const s of b.missing) toAdd.push({ symbol: s, sector });
    for (const s of b.stale) toRemove.push({ symbol: s, sector });
    for (const m of b.mismatched) toRelabel.push(m);
  }

  if (toAdd.length) {
    lines.push('Add to sectorMap.js:');
    lines.push('```js');
    toAdd.sort((a, b) => a.symbol.localeCompare(b.symbol));
    for (const a of toAdd) lines.push(`  "${a.symbol}": "${a.sector}",`);
    lines.push('```');
    lines.push('');
  }
  if (toRemove.length) {
    lines.push('Remove from sectorMap.js:');
    toRemove.sort((a, b) => a.symbol.localeCompare(b.symbol));
    for (const r of toRemove) lines.push(`- ${r.symbol} (was: ${r.sector})`);
    lines.push('');
  }
  if (toRelabel.length) {
    lines.push('Re-label in sectorMap.js:');
    toRelabel.sort((a, b) => a.symbol.localeCompare(b.symbol));
    for (const m of toRelabel) {
      lines.push(`- ${m.symbol}: ${m.hardcodedSector} -> ${m.liveSector}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let sectorsToCheck = Object.keys(NSE_SECTOR_INDICES);
  if (args.sector) {
    if (!NSE_SECTOR_INDICES[args.sector]) {
      console.error(
        `Unknown sector "${args.sector}". Known labels: ${sectorsToCheck.join(', ')}`,
      );
      process.exit(2);
    }
    sectorsToCheck = [args.sector];
  }

  // Filter hardcoded to only the sectors we're checking (when --sector is used).
  const hardcoded = args.sector
    ? Object.fromEntries(Object.entries(STOCK_SECTOR).filter(([, s]) => s === args.sector))
    : STOCK_SECTOR;

  const { live, skipped } = await fetchLiveSectors(sectorsToCheck);
  const diff = diffSectorSets(hardcoded, live);
  const asOfDate = new Date().toISOString().slice(0, 10);

  // Always write the JSON artefact.
  const outDir = resolve(REPO_ROOT, 'cache', 'sector-map-diff');
  await mkdir(outDir, { recursive: true });
  const outPath = resolve(outDir, `sector-diff-${fsTimestamp()}.json`);
  const payload = {
    asOfDate,
    sectorsChecked: sectorsToCheck,
    skipped,
    diff,
  };
  await writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(formatReport(diff, skipped, asOfDate));
    console.log('');
    console.log(`JSON diff written to: ${outPath}`);
  }

  // Exit 1 on drift OR when every sector was skipped (nothing useful to say).
  if (diff.hasDrift) process.exit(1);
  if (skipped.length === sectorsToCheck.length) {
    console.error('All sectors skipped (no live data). Treating as failure.');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error in check-sector-map-freshness:', err);
  process.exit(2);
});
