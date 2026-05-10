/**
 * Scan loop body.
 *
 * Per tick:
 *   1. Fetch index symbols (cached for the IST trading day).
 *   2. Concurrently fetch live OHLCV from Yahoo (5-way concurrency).
 *   3. Run detectPatterns / detectLiquidityBox / computeRiskScore.
 *   4. Filter by confidence ≥ minConfidence and actionable side.
 *   5. recordSignal() — disk-backed dedup keyed by (symbol, bar-ts, pattern).
 *   6. Notify each NEW signal (boot-time scan replays today's signals once
 *      for any signal not yet persisted from a prior session).
 *
 * Layered context (VIX / news / sector / index direction / regime gate)
 * is intentionally absent in v1. The scan emits the base pattern + risk
 * output; layering is incremental.
 */

import log from './log.mjs';
import { notify } from './notify.mjs';
import { baseUrl } from './config.mjs';
import { detectPatterns } from '../../src/engine/patterns-v2.js';
import { detectLiquidityBox } from '../../src/engine/liquidityBox-v2.js';
import { computeRiskScore } from '../../src/engine/risk-v2.js';
import { fetchLiveCandles } from './lib/yahoo.mjs';
import { getIndexSymbols } from './lib/symbols.mjs';
import { marketState } from './lib/market-hours.mjs';
import { recordSignal } from './lib/state.mjs';

const PWA_BASE = 'https://utkarsh9891.github.io/candlescan';
const ACTIONABLE = new Set(['STRONG BUY', 'BUY', 'STRONG SHORT', 'SHORT']);
const FETCH_CONCURRENCY = 5;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export async function runScan({ cfg, provider, scanCount, eventBus }) {
  const ms = marketState();
  if (!ms.open) {
    log.scan(
      `#${scanCount} market ${ms.reason} (${ms.hhmm} IST) — scanning anyway with most-recent data`,
    );
  } else {
    log.scan(`#${scanCount} market open (${ms.hhmm} IST)`);
  }

  let symbols;
  try {
    symbols = await getIndexSymbols(cfg.scan.index);
  } catch (e) {
    log.err(`failed to fetch ${cfg.scan.index} symbols: ${e.message}`);
    return;
  }

  const t0 = Date.now();
  log.scan(
    `#${scanCount} ${cfg.scan.index} (${symbols.length} stocks) ` +
      `tf=${cfg.scan.timeframe} conf>=${cfg.scan.minConfidence}`,
  );

  const results = await pMap(
    symbols,
    async (sym) => {
      try {
        const data = await fetchLiveCandles(sym, cfg.scan.timeframe);
        if (!data?.candles?.length || data.candles.length < 10) return null;
        return { sym, ...data };
      } catch (e) {
        return { sym, error: e.message };
      }
    },
    FETCH_CONCURRENCY,
  );

  let scanned = 0;
  let errors = 0;
  let hits = 0;
  let news = 0;

  for (const r of results) {
    if (!r) continue;
    if (r.error) {
      errors++;
      continue;
    }
    scanned++;
    const sig = evaluateStock(r.sym, r.candles, cfg);
    if (!sig) continue;
    hits++;
    const stored = recordSignal(sig);
    if (!stored.stored) continue; // dedup hit — already notified earlier today.
    news++;
    eventBus?.publish('signal:new', stored.signal);
    await emitSignalNotification({ cfg, provider, sig: stored.signal });
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  log.scanOk(
    `#${scanCount} done in ${dt}s · scanned=${scanned} err=${errors} hits=${hits} new=${news}`,
  );
  eventBus?.publish('scan:tick', {
    scanCount,
    durationSec: Number(dt),
    scanned,
    errors,
    hits,
    new: news,
  });
}

function istDateOf(ts) {
  return new Date(ts * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function evaluateStock(symbol, candles, cfg) {
  const cur = candles[candles.length - 1];
  if (!cur) return null;

  const latestDay = istDateOf(cur.t);
  let stockDayOpen = null;
  for (const c of candles) {
    if (istDateOf(c.t) === latestDay) {
      stockDayOpen = c.o;
      break;
    }
  }

  const patterns = detectPatterns(candles, { stockDayOpen });
  if (!patterns?.length) return null;

  const box = detectLiquidityBox(candles);
  const risk = computeRiskScore({
    candles,
    patterns,
    box,
    opts: { stockDayOpen },
  });
  if (!risk) return null;
  if (risk.confidence < cfg.scan.minConfidence) return null;
  if (!ACTIONABLE.has(risk.action)) return null;

  const top = patterns[0];
  return {
    symbol,
    barTs: cur.t,
    direction: risk.direction,
    action: risk.action,
    confidence: risk.confidence,
    pattern: top.name,
    entry: risk.entry,
    sl: risk.sl,
    target: risk.target,
  };
}

async function emitSignalNotification({ cfg, provider, sig }) {
  const fmt = (n) => (typeof n === 'number' ? n.toFixed(2) : '—');
  log.signal(
    `${sig.symbol.padEnd(10)} conf=${sig.confidence} ` +
      `${sig.action.padEnd(12)} ${sig.pattern} ` +
      `entry=${fmt(sig.entry)} SL=${fmt(sig.sl)} T=${fmt(sig.target)}`,
  );

  const cockpit = baseUrl(cfg);
  const tag =
    sig.direction === 'long'
      ? 'chart_with_upwards_trend'
      : 'chart_with_downwards_trend';

  await notify(provider, {
    title: `${sig.symbol} — ${sig.action}`,
    message:
      `conf=${sig.confidence}  ${sig.pattern}\n` +
      `entry=${fmt(sig.entry)}  SL=${fmt(sig.sl)}  T=${fmt(sig.target)}`,
    priority: 4,
    tags: [tag],
    click: `${PWA_BASE}/?symbol=${encodeURIComponent(sig.symbol)}`,
    actions: [
      {
        label: 'Enter Paper Trade',
        url:
          `${cockpit}/api/trades/enter` +
          `?sig=${encodeURIComponent(sig.id)}`,
        clear: true,
      },
      {
        label: 'View Detail',
        url: `${PWA_BASE}/?symbol=${encodeURIComponent(sig.symbol)}`,
      },
    ],
  });
}

async function pMap(items, fn, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const idx = next++;
        if (idx >= items.length) return;
        results[idx] = await fn(items[idx], idx);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
