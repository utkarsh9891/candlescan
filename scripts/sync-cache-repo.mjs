#!/usr/bin/env node
/**
 * Stage, commit, and push any new chart data into the sibling
 * candlescan-cache repo.
 *
 * Run after `npm run cache:warm` to publish the warmed bars:
 *
 *   npm run cache:warm -- --all-timeframes --index "NIFTY 200"
 *   npm run cache:sync
 *
 * No-ops cleanly if nothing was warmed. Refuses to run when CACHE_ROOT
 * resolves to the in-repo legacy fallback (no point committing
 * candlescan-cache contents into candlescan).
 */
import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { CACHE_ROOT } from './lib/cache-root.mjs';

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: CACHE_ROOT, encoding: 'utf8', ...opts });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(`${cmd} ${args.join(' ')} → exit ${result.status}${stderr ? `\n${stderr}` : ''}`);
  }
  return (result.stdout || '').trim();
}

function main() {
  // Refuse the legacy in-repo case: nothing to sync if cache lives inside candlescan.
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  if (path.resolve(CACHE_ROOT) === path.join(repoRoot, 'cache')) {
    console.error(`[cache:sync] CACHE_ROOT is the legacy in-repo fallback (${CACHE_ROOT}).`);
    console.error('Clone https://github.com/utkarsh9891/candlescan-cache as a sibling, or set CANDLESCAN_CACHE_DIR.');
    process.exit(1);
  }

  if (!fs.existsSync(path.join(CACHE_ROOT, '.git'))) {
    console.error(`[cache:sync] CACHE_ROOT (${CACHE_ROOT}) is not a git repo.`);
    process.exit(1);
  }

  // Stage any new/changed chart files.
  console.log(`[cache:sync] CACHE_ROOT = ${CACHE_ROOT}`);
  console.log('[cache:sync] staging charts/...');
  run('git', ['add', 'charts/']);

  // Anything to commit?
  const status = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: CACHE_ROOT });
  if (status.status === 0) {
    console.log('[cache:sync] no new chart data — nothing to commit.');
    return;
  }

  const stagedFiles = run('git', ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  const dateStamp = new Date().toISOString().slice(0, 10);
  const message = `Cache update ${dateStamp}: ${stagedFiles.length} changed files`;

  console.log(`[cache:sync] committing ${stagedFiles.length} files...`);
  run('git', ['commit', '-m', message]);

  console.log('[cache:sync] pushing to origin...');
  // Inherit stdio so the user sees progress on the (potentially large) push.
  const push = spawnSync('git', ['push'], { cwd: CACHE_ROOT, stdio: 'inherit' });
  if (push.status !== 0) {
    console.error('\n[cache:sync] push failed. Resolve manually:');
    console.error(`  cd ${CACHE_ROOT} && git pull --rebase && git push`);
    process.exit(push.status || 1);
  }

  console.log(`\n[cache:sync] done — committed and pushed: "${message}"`);
}

try {
  main();
} catch (err) {
  console.error(`[cache:sync] ${err.message || err}`);
  process.exit(1);
}
