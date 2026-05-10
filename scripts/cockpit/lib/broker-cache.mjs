/**
 * Disk-backed cache for broker instrument maps. Each map is a giant
 * symbol → broker-id JSON object — Kite ~3 MB, Dhan ~32 MB. Refetching
 * on every cockpit boot would be wasteful (and rate-limit-risky); we
 * cache to ~/.candlescan/cockpit/cache/<broker>-instruments.json with
 * a per-broker TTL.
 *
 * On read: if the cache file exists and is younger than ttlMs, returns
 * the parsed map. Otherwise calls fetcher() and writes the result.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CACHE_DIR = path.join(os.homedir(), '.candlescan', 'cockpit', 'cache');

function cachePath(broker) {
  return path.join(CACHE_DIR, `${broker}-instruments.json`);
}

/**
 * @param {string} broker — "zerodha" | "dhan"
 * @param {number} ttlMs — cache validity window
 * @param {() => Promise<Record<string,string|number>>} fetcher — produces a fresh map
 * @returns {Promise<Record<string,string|number>>}
 */
export async function loadInstrumentMap(broker, ttlMs, fetcher) {
  const fp = cachePath(broker);
  if (fs.existsSync(fp)) {
    try {
      const stat = fs.statSync(fp);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < ttlMs) {
        const map = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (map && typeof map === 'object') return map;
      }
    } catch {
      /* corrupt file — re-fetch */
    }
  }
  const map = await fetcher();
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(map));
  } catch {
    /* disk write failed — fine, we'll just refetch next boot */
  }
  return map;
}

export function instrumentCachePath(broker) {
  return cachePath(broker);
}
