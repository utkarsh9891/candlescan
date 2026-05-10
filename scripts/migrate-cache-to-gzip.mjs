#!/usr/bin/env node
/**
 * One-shot migration: convert every cache/charts/**\/*.json into the
 * gzipped equivalent (.json.gz) and delete the original.
 *
 * Run after upgrading scripts/lib/chart-cache-fs.mjs to the gzipped
 * format. Idempotent — files that already have a .json.gz sibling are
 * skipped (the .json is still removed if the .gz exists, since two
 * copies of the same data would cost disk for nothing).
 *
 *   node scripts/migrate-cache-to-gzip.mjs              # migrates the resolved CACHE_ROOT
 *   CANDLESCAN_CACHE_DIR=/path node scripts/migrate-cache-to-gzip.mjs
 *
 * Reports bytes-before / bytes-after so you can sanity-check the win
 * before doing a big git commit. Per-symbol-folder atomicity: each
 * symbol+interval directory is migrated in one pass so an interrupted
 * run never leaves a single date split across both formats.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CHART_CACHE_DIR } from './lib/chart-cache-fs.mjs';

function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function migrate() {
  if (!fs.existsSync(CHART_CACHE_DIR)) {
    console.error(`No charts dir at ${CHART_CACHE_DIR}`);
    process.exit(1);
  }
  console.log(`Migrating cache at: ${CHART_CACHE_DIR}\n`);

  let totalJsonFiles = 0;
  let totalGzFiles = 0;
  let totalBytesBefore = 0;
  let totalBytesAfter = 0;
  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  const startTime = Date.now();

  // Match listCachedSymbols(): A-Z, 0-9, or ^ — digit-leading tickers like
  // 3MINDIA.NS and 360ONE.NS are valid NSE symbols, while `.claude` and other
  // dotfiles must stay out.
  const symbols = fs.readdirSync(CHART_CACHE_DIR).filter((f) => /^[A-Z0-9^]/.test(f));
  console.log(`${symbols.length} symbol directories to walk.`);

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const symDir = path.join(CHART_CACHE_DIR, symbol);
    if (!fs.statSync(symDir).isDirectory()) continue;

    const intervals = fs.readdirSync(symDir).filter((f) => {
      try { return fs.statSync(path.join(symDir, f)).isDirectory(); }
      catch { return false; }
    });

    for (const interval of intervals) {
      const intervalDir = path.join(symDir, interval);
      const files = fs.readdirSync(intervalDir);
      for (const f of files) {
        if (f.endsWith('.json.gz')) {
          totalGzFiles++;
          continue;
        }
        if (!f.endsWith('.json')) continue;
        totalJsonFiles++;
        const jsonPath = path.join(intervalDir, f);
        const gzPath = `${jsonPath}.gz`;
        try {
          const beforeBytes = fs.statSync(jsonPath).size;
          totalBytesBefore += beforeBytes;
          if (fs.existsSync(gzPath)) {
            // Earlier run already converted this entry; just drop the
            // stale .json so we don't keep both copies on disk.
            fs.unlinkSync(jsonPath);
            skipped++;
            continue;
          }
          const raw = fs.readFileSync(jsonPath);
          const compressed = zlib.gzipSync(raw);
          const tmp = `${gzPath}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, compressed);
          fs.renameSync(tmp, gzPath);
          fs.unlinkSync(jsonPath);
          totalBytesAfter += compressed.length;
          migrated++;
        } catch (err) {
          errors++;
          console.error(`  err ${jsonPath}: ${err.message}`);
        }
      }
    }

    if ((i + 1) % 50 === 0 || i === symbols.length - 1) {
      const pct = (((i + 1) / symbols.length) * 100).toFixed(0);
      const elapsedS = ((Date.now() - startTime) / 1000).toFixed(0);
      process.stdout.write(
        `\r  ${i + 1}/${symbols.length} symbols (${pct}%) — ${migrated} migrated, ${skipped} de-duped, ${errors} err, ${elapsedS}s`,
      );
    }
  }

  const elapsedMin = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log('\n\n=== Migration Complete ===');
  console.log(`.json files seen      : ${totalJsonFiles}`);
  console.log(`.json.gz already there: ${totalGzFiles}`);
  console.log(`Migrated              : ${migrated}`);
  console.log(`De-duped (gz existed) : ${skipped}`);
  console.log(`Errors                : ${errors}`);
  console.log(`Bytes before          : ${fmtMB(totalBytesBefore)}`);
  console.log(`Bytes after           : ${fmtMB(totalBytesAfter)}`);
  if (totalBytesBefore > 0) {
    const ratio = (totalBytesBefore / Math.max(1, totalBytesAfter)).toFixed(1);
    const saved = totalBytesBefore - totalBytesAfter;
    console.log(`Compression ratio     : ${ratio}x`);
    console.log(`Saved on disk         : ${fmtMB(saved)}`);
  }
  console.log(`Time                  : ${elapsedMin} minutes`);
  if (errors > 0) process.exit(1);
}

migrate();
