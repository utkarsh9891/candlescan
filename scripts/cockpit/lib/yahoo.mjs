/**
 * Yahoo Finance v8 chart fetcher for live intraday scans.
 *
 * Targets `range=5d&interval=5m` (or 1m / 15m) — enough history for the
 * engine's pattern lookbacks plus the in-progress current bar.
 * Anonymous (no creds). NSE equity symbols use the `.NS` suffix on Yahoo.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';

/**
 * @param {string} symbol  NSE equity symbol without suffix (e.g. "RELIANCE")
 * @param {string} interval  "1m" | "5m" | "15m"
 * @param {string} range  "1d" | "5d" | "1mo"
 * @returns {Promise<{ candles: Array<{t,o,h,l,c,v}>, companyName: string } | null>}
 */
export async function fetchLiveCandles(symbol, interval = '5m', range = '5d') {
  const ysym = `${symbol}.NS`;
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}` +
    `?interval=${interval}&range=${range}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`yahoo HTTP ${res.status} for ${ysym}`);
  }
  const json = await res.json();
  return parseChart(json, symbol);
}

function parseChart(data, fallbackSymbol) {
  const r = data?.chart?.result?.[0];
  if (!r) return null;
  const meta = r.meta || {};
  const ts = r.timestamp;
  const q = r.indicators?.quote?.[0];
  if (!ts?.length || !q) return null;
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({ t: ts[i], o, h, l, c, v: q.volume?.[i] ?? 0 });
  }
  if (!candles.length) return null;
  return {
    candles,
    companyName: meta.longName || meta.shortName || meta.symbol || fallbackSymbol,
  };
}
