/**
 * Parse NSE `equity-stockIndices` JSON → EQ symbols (NSE tickers, Yahoo-compatible without .NS).
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
