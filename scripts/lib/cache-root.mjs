/**
 * Resolves the on-disk cache root.
 *
 * The chart cache (multi-GB of Yahoo OHLCV bars) lives in the sibling
 * candlescan-cache repo so it survives `git clean` and isn't bloating
 * candlescan history. Resolution order:
 *
 *   1. process.env.CANDLESCAN_CACHE_DIR  (explicit override)
 *   2. ../candlescan-cache/              (sibling clone, default)
 *   3. <repo>/cache/                     (legacy in-repo fallback)
 *
 * The legacy fallback keeps fresh candlescan-only clones from breaking
 * before the user clones candlescan-cache. Other cache subdirs
 * (trades/, walk-forward/, news/, ...) are not migrated and continue
 * to live under the resolved root, gitignored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

function resolveCacheRoot() {
  if (process.env.CANDLESCAN_CACHE_DIR) {
    return path.resolve(process.env.CANDLESCAN_CACHE_DIR);
  }
  const sibling = path.resolve(REPO_ROOT, '..', 'candlescan-cache');
  if (fs.existsSync(sibling)) return sibling;
  return path.join(REPO_ROOT, 'cache');
}

export const CACHE_ROOT = resolveCacheRoot();
