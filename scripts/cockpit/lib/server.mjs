/**
 * Cockpit HTTP server (Hono on Node).
 *
 * Routes:
 *   GET  /                      — cockpit web UI (single-page HTML)
 *   GET  /api/state             — { signals, trades, openTrades, summary }
 *   GET  /api/signals           — list of today's signals
 *   GET  /api/trades            — list of today's trades (open + closed)
 *   GET  /api/trades/enter      — enter paper trade (notification-button target)
 *                                  query: sym, barTs OR signalId
 *                                  returns confirmation HTML page
 *   POST /api/trades/:id/exit   — force-exit an open trade (manual)
 *   GET  /api/events            — SSE stream of {kind, payload} events
 *   GET  /healthz               — 200 OK
 *
 * Listens on cfg.host.port, bound to 0.0.0.0 so phones on the LAN can reach.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import log from '../log.mjs';
import {
  getSignals,
  getTrades,
  getOpenTrades,
  enterTrade,
  exitTrade,
} from './state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_INDEX = path.join(__dirname, '..', 'ui', 'index.html');

/**
 * Tiny in-process pub/sub for SSE broadcast.
 */
export function makeEventBus() {
  const subs = new Set();
  return {
    publish(kind, payload) {
      const msg = { kind, payload, ts: Date.now() };
      for (const fn of subs) {
        try {
          fn(msg);
        } catch {
          /* ignore subscriber errors */
        }
      }
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    size() {
      return subs.size;
    },
  };
}

function summary(trades) {
  let open = 0;
  let closed = 0;
  let netPnl = 0;
  let wins = 0;
  let losses = 0;
  for (const t of trades) {
    if (t.status === 'open') open++;
    else {
      closed++;
      netPnl += t.netPnl ?? 0;
      if ((t.netPnl ?? 0) > 0) wins++;
      else if ((t.netPnl ?? 0) < 0) losses++;
    }
  }
  return { open, closed, netPnl, wins, losses };
}

export function createApp({ cfg, eventBus }) {
  const app = new Hono();

  app.get('/healthz', (c) => c.text('ok'));

  app.get('/', (c) => {
    if (fs.existsSync(UI_INDEX)) {
      const html = fs.readFileSync(UI_INDEX, 'utf8');
      return c.html(html);
    }
    return c.text('cockpit ui missing — see scripts/cockpit/ui/index.html', 500);
  });

  app.get('/api/state', (c) => {
    const signals = getSignals();
    const trades = getTrades();
    return c.json({
      signals,
      trades,
      openTrades: trades.filter((t) => t.status === 'open'),
      summary: summary(trades),
      cfg: {
        engine: cfg.scan.engine,
        index: cfg.scan.index,
        timeframe: cfg.scan.timeframe,
        minConfidence: cfg.scan.minConfidence,
        intervalSec: cfg.scan.intervalSec,
      },
    });
  });

  app.get('/api/signals', (c) => c.json(getSignals()));

  app.get('/api/trades', (c) => c.json(getTrades()));

  app.get('/api/trades/enter', (c) => {
    const sym = c.req.query('sym');
    const barTs = c.req.query('barTs');
    const signalId = c.req.query('sig');
    if (!sym && !signalId) {
      return c.html(confirmPage('Missing parameters', 'Need ?sym=&barTs= or ?sig=', false), 400);
    }
    const result = enterTrade({ signalId, sym, barTs });
    if (!result.ok) {
      log.warn(`/api/trades/enter rejected: ${result.error} (sym=${sym} barTs=${barTs})`);
      return c.html(confirmPage('Trade rejected', result.error, false), 400);
    }
    const t = result.trade;
    if (result.alreadyExisted) {
      return c.html(
        confirmPage(
          `${t.symbol}: already entered`,
          `Trade ${t.id} is open at entry ${t.entry.toFixed(2)} (${t.shares} shares).`,
          true,
        ),
      );
    }
    log.tradeIn(
      `ENTRY ${t.symbol}  ${t.shares} @ ${t.entry.toFixed(2)} ` +
        `SL=${t.sl.toFixed(2)} T=${t.target.toFixed(2)} ` +
        `size=Rs ${t.positionSize.toLocaleString('en-IN')} ` +
        `exposure=Rs ${t.exposure.toLocaleString('en-IN')}`,
    );
    eventBus?.publish('trade:enter', t);
    return c.html(
      confirmPage(
        `${t.symbol} entered`,
        `${t.shares} shares @ ${t.entry.toFixed(2)} · SL ${t.sl.toFixed(2)} · T ${t.target.toFixed(2)}`,
        true,
      ),
    );
  });

  app.post('/api/trades/:id/exit', async (c) => {
    const id = c.req.param('id');
    let body = {};
    try {
      body = await c.req.json();
    } catch {
      /* empty body OK */
    }
    const exitPrice = Number(body.exitPrice);
    const exitReason = body.exitReason || 'manual';
    if (!Number.isFinite(exitPrice)) {
      return c.json({ ok: false, error: 'exitPrice required' }, 400);
    }
    const result = exitTrade({ tradeId: id, exitPrice, exitReason });
    if (!result.ok) return c.json(result, 400);
    log.tradeOut(
      `EXIT ${result.trade.symbol} @ ${exitPrice.toFixed(2)} ` +
        `[${exitReason}] netPnl=${(result.trade.netPnl ?? 0).toFixed(0)}`,
    );
    eventBus?.publish('trade:exit', result.trade);
    return c.json(result);
  });

  // Server-Sent Events for the cockpit UI's live tab.
  app.get('/api/events', (c) => {
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const write = (msg) => {
          try {
            controller.enqueue(
              enc.encode(`data: ${JSON.stringify(msg)}\n\n`),
            );
          } catch {
            /* downstream closed */
          }
        };
        write({ kind: 'hello', ts: Date.now() });
        const unsub = eventBus.subscribe(write);
        // Heartbeat every 25s keeps proxies from killing idle SSE.
        const hb = setInterval(() => write({ kind: 'ping', ts: Date.now() }), 25_000);
        const cleanup = () => {
          clearInterval(hb);
          unsub();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        c.req.raw.signal?.addEventListener('abort', cleanup);
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  });

  app.notFound((c) => c.text('not found', 404));

  return app;
}

function confirmPage(title, body, success) {
  const colour = success ? '#22c55e' : '#ef4444';
  const safe = (s) =>
    String(s).replace(/[&<>"']/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]),
    );
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>${safe(title)}</title>
<style>
  body { margin:0; padding:32px 20px; font: 16px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0a0a0a; color:#e5e5e5; }
  .card { max-width: 480px; margin: 24px auto; background:#171717; border:1px solid #262626; border-radius:12px; padding:24px; }
  h1 { margin:0 0 12px; font-size:20px; color:${colour}; }
  p  { margin:0 0 18px; color:#a3a3a3; }
  a.btn { display:inline-block; padding:10px 16px; background:#262626; color:#e5e5e5; border-radius:8px; text-decoration:none; margin-right:8px; }
  a.btn:hover { background:#333; }
</style>
<div class="card">
  <h1>${safe(title)}</h1>
  <p>${safe(body)}</p>
  <a class="btn" href="/">Open cockpit</a>
</div>`;
}

/**
 * Start the HTTP server. Returns the underlying Node http.Server so the
 * caller can close it on shutdown.
 */
export function startServer({ cfg, eventBus }) {
  const app = createApp({ cfg, eventBus });
  const port = cfg.host.port;
  const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' });
  log.boot(`http listening on 0.0.0.0:${port}`);
  return server;
}
