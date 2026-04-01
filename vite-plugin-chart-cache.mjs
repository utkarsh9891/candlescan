/**
 * Vite dev only: serve Yahoo chart from date-partitioned cache; else proxy-fetch Yahoo and save.
 *
 * Cache structure: cache/charts/{SYMBOL}/{interval}/{YYYY-MM-DD}.json
 *
 * Supports two URL styles:
 *   1. Date-specific: ?interval=1m&period1=UNIX&period2=UNIX (new, preferred)
 *   2. Range-based: ?interval=5m&range=5d (legacy, still proxied to Yahoo but cached by date)
 */
import https from 'node:https';
import {
  readCachedChartJson,
  writeCachedChartJson,
  parseYahooDevChartRequest,
  unixToIstDate,
} from './scripts/lib/chart-cache-fs.mjs';

function isChartCacheDisabled() {
  return process.env.CANDLESCAN_CHART_CACHE === '0' || process.env.CANDLESCAN_CHART_CACHE === 'false';
}

/**
 * Extract dates from Yahoo chart JSON response and write per-date cache files.
 * A single Yahoo response may contain multiple trading days (e.g. range=5d).
 */
function cacheYahooResponse(symbol, interval, json) {
  const r = json?.chart?.result?.[0];
  if (!r?.timestamp?.length) return;
  const ts = r.timestamp;
  const q = r.indicators?.quote?.[0];
  if (!q) return;

  // Group timestamps by IST date
  const dateGroups = {};
  for (let i = 0; i < ts.length; i++) {
    const date = unixToIstDate(ts[i]);
    if (!dateGroups[date]) dateGroups[date] = [];
    dateGroups[date].push(i);
  }

  // Write one cache file per date
  for (const [date, indices] of Object.entries(dateGroups)) {
    const dateTs = indices.map(i => ts[i]);
    const dateQuote = {
      open: indices.map(i => q.open?.[i] ?? null),
      high: indices.map(i => q.high?.[i] ?? null),
      low: indices.map(i => q.low?.[i] ?? null),
      close: indices.map(i => q.close?.[i] ?? null),
      volume: indices.map(i => q.volume?.[i] ?? null),
    };
    const dateJson = {
      chart: {
        result: [{
          meta: r.meta,
          timestamp: dateTs,
          indicators: { quote: [dateQuote] },
        }],
        error: null,
      },
    };
    writeCachedChartJson(symbol, interval, date, dateJson);
  }
}

export function chartCacheDevPlugin() {
  return {
    name: 'candlescan-chart-cache',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' || !req.url || isChartCacheDisabled()) return next();
        if (!req.url.includes('/__candlescan-yahoo/v8/finance/chart/')) return next();

        const parsed = parseYahooDevChartRequest(req.url);
        if (!parsed) return next();

        // If date-specific request (period1/period2), try cache
        if (parsed.date) {
          const cached = readCachedChartJson(parsed.symbol, parsed.interval, parsed.date);
          if (cached != null) {
            const body = JSON.stringify(cached);
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Length', Buffer.byteLength(body));
            res.setHeader('X-CandleScan-Chart-Cache', 'hit');
            res.end(body);
            return;
          }
        }

        // Build Yahoo URL
        let yPath;
        if (parsed.period1 && parsed.period2) {
          yPath = `/v8/finance/chart/${encodeURIComponent(parsed.symbol)}?interval=${encodeURIComponent(parsed.interval)}&period1=${parsed.period1}&period2=${parsed.period2}`;
        } else {
          yPath = `/v8/finance/chart/${encodeURIComponent(parsed.symbol)}?interval=${encodeURIComponent(parsed.interval)}&range=${encodeURIComponent(parsed.range || '5d')}`;
        }

        const opts = {
          hostname: 'query1.finance.yahoo.com',
          path: yPath,
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; CandleScanDev/1.0)',
            Accept: 'application/json',
          },
        };

        const yreq = https.request(opts, (yres) => {
          const chunks = [];
          yres.on('data', (c) => chunks.push(c));
          yres.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (yres.statusCode === 200) {
              try {
                const j = JSON.parse(buf.toString());
                cacheYahooResponse(parsed.symbol, parsed.interval, j);
              } catch {
                /* still return body */
              }
            }
            res.setHeader('X-CandleScan-Chart-Cache', 'miss');
            res.writeHead(yres.statusCode || 502, {
              'Content-Type': yres.headers['content-type'] || 'application/json',
            });
            res.end(buf);
          });
        });
        yreq.on('error', () => next());
        yreq.end();
      });
    },
  };
}
