/**
 * Pure diff helper for sector-map freshness checker.
 *
 * Compares a hardcoded stock→sector map (from src/engine/sectorMap.js) against
 * live NSE sector constituents. Returns structured buckets so callers can print
 * a report, write JSON, and decide exit codes.
 *
 * Kept separate from scripts/check-sector-map-freshness.mjs so it can be unit
 * tested without pulling in Node-only fetch code.
 *
 * @param {Record<string, string>} hardcoded
 *   SYMBOL → sector label (e.g. { HDFCBANK: 'BANK', ... }).
 * @param {Record<string, string[]>} live
 *   sector label → array of NSE symbols (e.g. { BANK: ['HDFCBANK', ...] }).
 *   Only sectors present as keys here are considered; sectors with undefined
 *   live lists (e.g. fetch failed) must not be passed in — use the
 *   `skippedSectors` field of the diff wrapper to track those.
 * @returns {{
 *   perSector: Record<string, {
 *     upToDate: string[],
 *     missing: string[],
 *     stale: string[],
 *     mismatched: Array<{ symbol: string, hardcodedSector: string, liveSector: string }>,
 *   }>,
 *   totals: {
 *     upToDate: number,
 *     missing: number,
 *     stale: number,
 *     mismatched: number,
 *   },
 *   hasDrift: boolean,
 * }}
 */
export function diffSectorSets(hardcoded, live) {
  const perSector = {};
  const totals = { upToDate: 0, missing: 0, stale: 0, mismatched: 0 };

  // Invert hardcoded for reverse lookups (sector -> Set of symbols).
  const hardcodedBySector = {};
  for (const [sym, sec] of Object.entries(hardcoded || {})) {
    if (!hardcodedBySector[sec]) hardcodedBySector[sec] = new Set();
    hardcodedBySector[sec].add(sym);
  }

  // Union of live symbols across all sectors (for "live has symbol somewhere"
  // checks when resolving mismatched vs stale).
  const liveSymbolToSector = {};
  for (const [sec, syms] of Object.entries(live || {})) {
    for (const s of syms || []) {
      // First occurrence wins; NSE indices mostly don't overlap, and ambiguity
      // would just produce a best-effort mismatch label.
      if (!liveSymbolToSector[s]) liveSymbolToSector[s] = sec;
    }
  }

  for (const [sector, liveSymsRaw] of Object.entries(live || {})) {
    const liveSyms = new Set(liveSymsRaw || []);
    const hcSyms = hardcodedBySector[sector] || new Set();

    const upToDate = [];
    const missing = [];
    const stale = [];
    const mismatched = [];

    // Symbols in live index for this sector — classify against hardcoded.
    for (const s of liveSyms) {
      const hcSector = hardcoded[s];
      if (hcSector === sector) {
        upToDate.push(s);
      } else if (hcSector && hcSector !== sector) {
        // Hardcoded has it but under a different label.
        mismatched.push({ symbol: s, hardcodedSector: hcSector, liveSector: sector });
      } else {
        // Not in hardcoded at all → missing from sectorMap under this sector.
        missing.push(s);
      }
    }

    // Stale: hardcoded symbols tagged with this sector but absent from the
    // live constituents for that sector. If the symbol appears in another live
    // sector, that's already counted as a mismatched row for *that* sector —
    // we still flag it here so readers of this sector's bucket see it.
    for (const s of hcSyms) {
      if (!liveSyms.has(s)) {
        stale.push(s);
      }
    }

    upToDate.sort();
    missing.sort();
    stale.sort();
    mismatched.sort((a, b) => a.symbol.localeCompare(b.symbol));

    perSector[sector] = { upToDate, missing, stale, mismatched };
    totals.upToDate += upToDate.length;
    totals.missing += missing.length;
    totals.stale += stale.length;
    totals.mismatched += mismatched.length;
  }

  const hasDrift = totals.missing > 0 || totals.stale > 0 || totals.mismatched > 0;
  return { perSector, totals, hasDrift };
}

/** Timestamp string safe for filenames: 2026-04-21T14-32-05Z. */
export function fsTimestamp(d = new Date()) {
  return d.toISOString().replace(/:/g, '-').replace(/\.\d+/, '');
}
