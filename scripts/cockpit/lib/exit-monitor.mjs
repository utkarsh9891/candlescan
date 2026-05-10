/**
 * Paper-trade exit monitor.
 *
 * Runs on its own interval (default 30s). For each open trade:
 *   1. Fetch the latest 1m candle for the symbol from Yahoo.
 *   2. Apply exit rules:
 *      - SL hit  → exit at trade.sl
 *      - Target hit → exit at trade.target
 *      - EOD (after 15:30 IST on the trade's entry day) → exit at last close
 *      - (long) breakeven trail: when high >= entry × 1.015 ratchet SL to
 *        entry × 1.002. Mirror image for shorts. Mirrors the simulator
 *        (scripts/simulate-day.mjs) wave-3 trail rule.
 *   3. Emit notification + log on each transition.
 *
 * Day 5 v1: single-leg exits only. Multi-tranche entries (Trend Continuation
 * Pullback) are recorded with their tranche schedule but exited as a
 * single-leg at the *first* tranche target — TODO: full per-tranche exits
 * after dogfooding confirms the single-leg behavior is correct.
 */

import log from '../log.mjs';
import { notify } from '../notify.mjs';
import { baseUrl } from '../config.mjs';
import { fetchLiveCandles } from './yahoo.mjs';
import { getOpenTrades, exitTrade, trailSl } from './state.mjs';
import { marketState } from './market-hours.mjs';

const PWA_BASE = 'https://utkarsh9891.github.io/candlescan';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function nowIstMinutes() {
  const d = new Date(Date.now() + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export async function runExitMonitor({ cfg, provider, eventBus }) {
  const open = getOpenTrades();
  if (!open.length) return;

  const ms = marketState();
  const istMins = nowIstMinutes();
  const eodMins = 15 * 60 + 30;
  const isAfterClose = ms.open === false && (ms.reason === 'after-close');

  log.scan(`exit-monitor: ${open.length} open trade(s) [${ms.hhmm} IST · ${ms.reason ?? 'open'}]`);

  for (const t of open) {
    let candles;
    try {
      const data = await fetchLiveCandles(t.symbol, '1m', '1d');
      candles = data?.candles;
    } catch (e) {
      log.warn(`exit-monitor: yahoo fetch failed for ${t.symbol}: ${e.message}`);
      continue;
    }
    if (!candles?.length) continue;

    // Restrict to bars at-or-after the entry timestamp so we don't apply
    // exit rules using historical bars from before the trade existed.
    const since = t.enteredAtTs - 60; // include the entry bar
    const recent = candles.filter((c) => c.t >= since);
    if (!recent.length) continue;

    // Breakeven trail (long: high crosses entry × 1.015 → SL up to entry × 1.002).
    if (t.direction === 'long') {
      const peakHigh = Math.max(...recent.map((c) => c.h));
      if (peakHigh >= t.entry * 1.015) {
        const breakeven = t.entry * 1.002;
        if (breakeven > t.sl) {
          if (trailSl({ tradeId: t.id, newSl: breakeven, note: 'breakeven trail @ +1.5%' })) {
            log.scan(`trail ${t.symbol}: SL ${t.sl.toFixed(2)} → ${breakeven.toFixed(2)}`);
            eventBus?.publish('trade:trail', { symbol: t.symbol, newSl: breakeven });
            t.sl = breakeven;
          }
        }
      }
    } else {
      const peakLow = Math.min(...recent.map((c) => c.l));
      if (peakLow <= t.entry * 0.985) {
        const breakeven = t.entry * 0.998;
        if (breakeven < t.sl) {
          if (trailSl({ tradeId: t.id, newSl: breakeven, note: 'breakeven trail @ +1.5%' })) {
            log.scan(`trail ${t.symbol}: SL ${t.sl.toFixed(2)} → ${breakeven.toFixed(2)}`);
            eventBus?.publish('trade:trail', { symbol: t.symbol, newSl: breakeven });
            t.sl = breakeven;
          }
        }
      }
    }

    // Exit-condition scan over bars since entry.
    let exitPrice = null;
    let exitReason = null;

    for (const c of recent) {
      if (t.direction === 'long') {
        const slHit = c.l <= t.sl;
        const tgtHit = c.h >= t.target;
        if (slHit && tgtHit) {
          // Pessimistic intra-bar resolution: use bar direction as a proxy
          // for which barrier was touched first. Mirrors simulate-day.
          if (c.c >= c.o) { exitPrice = t.target; exitReason = 'TARGET'; }
          else { exitPrice = t.sl; exitReason = 'SL'; }
          break;
        }
        if (slHit) { exitPrice = t.sl; exitReason = 'SL'; break; }
        if (tgtHit) { exitPrice = t.target; exitReason = 'TARGET'; break; }
      } else {
        const slHit = c.h >= t.sl;
        const tgtHit = c.l <= t.target;
        if (slHit && tgtHit) {
          if (c.c <= c.o) { exitPrice = t.target; exitReason = 'TARGET'; }
          else { exitPrice = t.sl; exitReason = 'SL'; }
          break;
        }
        if (slHit) { exitPrice = t.sl; exitReason = 'SL'; break; }
        if (tgtHit) { exitPrice = t.target; exitReason = 'TARGET'; break; }
      }
    }

    // EOD fallback — only after market close, exit at last available close.
    if (!exitPrice && (isAfterClose || istMins > eodMins)) {
      const last = recent[recent.length - 1];
      exitPrice = last.c;
      exitReason = 'EOD';
    }

    if (!exitPrice) continue;

    const result = exitTrade({ tradeId: t.id, exitPrice, exitReason });
    if (!result.ok) {
      log.warn(`exit-monitor: exit failed for ${t.symbol}: ${result.error}`);
      continue;
    }
    const ex = result.trade;
    log.tradeOut(
      `EXIT ${ex.symbol} @ ${exitPrice.toFixed(2)} [${exitReason}] ` +
        `entry=${ex.entry.toFixed(2)}  netPnl=Rs ${Math.round(ex.netPnl).toLocaleString('en-IN')}`,
    );
    eventBus?.publish('trade:exit:auto', ex);

    const cockpit = baseUrl(cfg);
    const winLoss = (ex.netPnl ?? 0) > 0 ? 'win' : (ex.netPnl ?? 0) < 0 ? 'loss' : 'flat';
    const emoji =
      winLoss === 'win' ? 'white_check_mark' : winLoss === 'loss' ? 'red_circle' : 'white_circle';
    await notify(provider, {
      title: `${ex.symbol} EXIT ${exitReason}`,
      message:
        `@ ${exitPrice.toFixed(2)}  [${exitReason}]\n` +
        `entry=${ex.entry.toFixed(2)}  netPnl=Rs ${Math.round(ex.netPnl).toLocaleString('en-IN')}`,
      priority: winLoss === 'loss' ? 5 : 4,
      tags: [emoji],
      click: `${cockpit}/`,
      actions: [
        { label: 'Open Cockpit', url: `${cockpit}/`, clear: false },
        {
          label: 'View Detail',
          url: `${PWA_BASE}/?symbol=${encodeURIComponent(ex.symbol)}`,
        },
      ],
    });
  }
}
