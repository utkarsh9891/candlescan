/**
 * Vite dev only: serve Yahoo chart from cache/charts when valid; else proxy-fetch Yahoo and save.
 */
import https from 'node:https';
import {
  readCachedChartJson,
  writeCachedChartJson,
  parseYahooDevChartRequest,
  getChartCacheMaxAgeMs,
} from './scripts/lib/chart-cache-fs.mjs';

function isChartCacheDisabled() {
  return process.env.CANDLESCAN_CHART_CACHE === '0' || process.env.CANDLESCAN_CHART_CACHE === 'false';
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

        const maxAge = getChartCacheMaxAgeMs();
        const cached = readCachedChartJson(parsed.symbol, parsed.interval, parsed.range, maxAge);
        if (cached != null) {
          const body = JSON.stringify(cached);
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Content-Length', Buffer.byteLength(body));
          res.setHeader('X-CandleScan-Chart-Cache', 'hit');
          res.end(body);
          return;
        }

        const yPath = `/v8/finance/chart/${encodeURIComponent(parsed.symbol)}?interval=${encodeURIComponent(parsed.interval)}&range=${encodeURIComponent(parsed.range)}`;
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
                writeCachedChartJson(parsed.symbol, parsed.interval, parsed.range, j);
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
