/**
 * Parse NSE `equity-stockIndices` JSON → EQ symbols + company name map.
 */
export function parseNseIndexSymbols(payload) {
  const rows = payload?.data;
  if (!Array.isArray(rows)) return [];
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (!r || r.series !== 'EQ' || typeof r.symbol !== 'string') continue;
    const s = r.symbol.trim().toUpperCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Parse NSE response → { symbols: string[], companyMap: Record<string, string> }
 * companyMap maps SYMBOL → "Company Name" from meta.companyName
 */
export function parseNseIndexWithNames(payload) {
  const rows = payload?.data;
  if (!Array.isArray(rows)) return { symbols: [], companyMap: {} };
  const symbols = [];
  const companyMap = {};
  const seen = new Set();
  for (const r of rows) {
    if (!r || r.series !== 'EQ' || typeof r.symbol !== 'string') continue;
    const s = r.symbol.trim().toUpperCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    symbols.push(s);
    const name = r.meta?.companyName || r.identifier || '';
    if (name) companyMap[s] = name;
  }
  return { symbols, companyMap };
}
