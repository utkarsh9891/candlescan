/**
 * Node: fetch NSE equity-stockIndices JSON (scripts only).
 */
import { NSE_EQUITY_INDICES_BASE } from '../../src/config/nseIndices.js';
import { parseNseIndexSymbols } from '../../src/engine/nseIndexParse.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export function buildNseIndexUrl(indexName) {
  const q = encodeURIComponent(indexName);
  return `${NSE_EQUITY_INDICES_BASE}?index=${q}`;
}

export async function fetchNseIndexSymbolsNode(indexName) {
  const url = buildNseIndexUrl(indexName);
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      Referer: 'https://www.nseindia.com/',
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`NSE HTTP ${res.status}`);
  const json = await res.json();
  const syms = parseNseIndexSymbols(json);
  if (!syms.length) throw new Error('No EQ symbols in NSE response');
  return syms;
}
