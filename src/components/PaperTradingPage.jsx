/**
 * Paper Trading — live simulation with real-time price polling.
 *
 * Flow: Scan index → Pick signals → Track live → Get notified → See P&L → Repeat
 *
 * Features:
 *  - Reuses batchScan() for index scanning
 *  - Polls Yahoo v7 quote API every 30s for live prices
 *  - Proper Indian intraday charge breakdown (STT, SEBI, stamp duty, GST)
 *  - Push notifications when trades hit TARGET/SL/TIME
 *  - localStorage persistence across page reloads
 *  - Day summary with enriching extras (win streak, avg hold, best/worst)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { NSE_INDEX_OPTIONS } from '../config/nseIndices.js';
import { fetchNseIndexSymbolList } from '../engine/nseIndexFetch.js';
import { batchScan } from '../engine/batchScan.js';
import { fetchYahooQuote } from '../engine/yahooQuote.js';
import { getBatchToken } from '../utils/batchAuth.js';
import { getIndexDirection } from '../engine/indexDirection.js';
import { getScalpVariantFns, SCALP_VARIANTS, DEFAULT_SCALP_VARIANT } from '../engine/scalp-variants/registry.js';
import { detectPatterns as detectPatternsV2 } from '../engine/patterns-v2.js';
import { detectLiquidityBox as detectLiquidityBoxV2 } from '../engine/liquidityBox-v2.js';
import { computeRiskScore as computeRiskScoreV2 } from '../engine/risk-v2.js';
import { detectPatterns as detectPatternsClassic } from '../engine/patterns-classic.js';
import { detectLiquidityBox as detectLiquidityBoxClassic } from '../engine/liquidityBox-classic.js';
import { computeRiskScore as computeRiskScoreClassic } from '../engine/risk-classic.js';
import { MARGIN_MULTIPLIER } from '../data/marginData.js';

const mono = "'SF Mono', Menlo, monospace";
const POLL_INTERVAL_MS = 30000; // 30 seconds
const STORAGE_KEY = 'candlescan_paper_trades';
const NOTIF_DISMISS_MS = 12000;

// ── Indian Intraday Charges ──────────────────────────────────────────────────
const CHARGES = {
  BROKERAGE_PER_ORDER: 20,           // Rs.20 flat per executed order
  STT_SELL_PCT: 0.00025,             // 0.025% on sell side only
  EXCHANGE_TURNOVER_PCT: 0.0000345,  // 0.00345% on turnover
  SEBI_PCT: 0.000001,               // 0.0001% (Rs.10 per crore)
  STAMP_DUTY_BUY_PCT: 0.00003,      // 0.003% on buy side
  GST_PCT: 0.18,                    // 18% on (brokerage + exchange + SEBI)
};

function getEngineFns(engine, variant) {
  if (engine === 'scalp') return getScalpVariantFns(variant || DEFAULT_SCALP_VARIANT);
  if (engine === 'v2') return { detectPatterns: detectPatternsV2, detectLiquidityBox: detectLiquidityBoxV2, computeRiskScore: computeRiskScoreV2 };
  return { detectPatterns: detectPatternsClassic, detectLiquidityBox: detectLiquidityBoxClassic, computeRiskScore: computeRiskScoreClassic };
}

function actionColor(a) {
  if (a === 'STRONG BUY' || a === 'BUY' || a === 'long') return '#16a34a';
  if (a === 'STRONG SHORT' || a === 'SHORT' || a === 'short') return '#dc2626';
  return '#8892a8';
}
function actionBg(a) {
  if (a === 'STRONG BUY' || a === 'BUY' || a === 'long') return '#f0fdf4';
  if (a === 'STRONG SHORT' || a === 'SHORT' || a === 'short') return '#fef2f2';
  return '#f5f6f8';
}
function reasonBg(r) {
  if (r === 'TARGET') return '#f0fdf4';
  if (r === 'SL') return '#fef2f2';
  if (r === 'TIME' || r === 'MANUAL') return '#fffbeb';
  return '#f5f6f8';
}
function reasonColor(r) {
  if (r === 'TARGET') return '#16a34a';
  if (r === 'SL') return '#dc2626';
  return '#d97706';
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function formatDuration(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
function fmtRs(n) {
  const sign = n >= 0 ? '+' : '';
  return sign + 'Rs.' + Math.round(Math.abs(n)).toLocaleString('en-IN');
}

// ── Charge computation ───────────────────────────────────────────────────────
function computeCharges(trade) {
  const { entry, exitPrice, shares, direction } = trade;
  if (!exitPrice) return null;
  const buyPrice = direction === 'long' ? entry : exitPrice;
  const sellPrice = direction === 'long' ? exitPrice : entry;
  const buyValue = buyPrice * shares;
  const sellValue = sellPrice * shares;
  const turnover = buyValue + sellValue;

  const brokerage = CHARGES.BROKERAGE_PER_ORDER * 2; // buy + sell
  const stt = sellValue * CHARGES.STT_SELL_PCT;
  const exchangeTurnover = turnover * CHARGES.EXCHANGE_TURNOVER_PCT;
  const sebiCharges = turnover * CHARGES.SEBI_PCT;
  const stampDuty = buyValue * CHARGES.STAMP_DUTY_BUY_PCT;
  const gstBase = brokerage + exchangeTurnover + sebiCharges;
  const gst = gstBase * CHARGES.GST_PCT;
  const totalCharges = brokerage + stt + exchangeTurnover + sebiCharges + stampDuty + gst;

  const grossPnl = direction === 'long'
    ? (exitPrice - entry) * shares
    : (entry - exitPrice) * shares;
  const netPnl = grossPnl - totalCharges;

  return { buyValue, sellValue, turnover, brokerage, stt, exchangeTurnover, sebiCharges, stampDuty, gst, totalCharges, grossPnl, netPnl };
}

function computeDaySummary(allTrades) {
  const closed = allTrades.filter(t => t.status === 'closed' && t.exitPrice);
  if (!closed.length) return null;
  const all = closed.map(t => ({ trade: t, charges: computeCharges(t) })).filter(x => x.charges);

  const totalGross = all.reduce((s, x) => s + x.charges.grossPnl, 0);
  const totalNet = all.reduce((s, x) => s + x.charges.netPnl, 0);
  const totalChargesSum = all.reduce((s, x) => s + x.charges.totalCharges, 0);
  const wins = all.filter(x => x.charges.netPnl > 0).length;

  const holdTimes = all.map(x => (x.trade.exitTime - x.trade.entryTime));
  const avgHoldMs = holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length;
  const bestTrade = Math.max(...all.map(x => x.charges.netPnl));
  const worstTrade = Math.min(...all.map(x => x.charges.netPnl));

  let maxStreak = 0, streak = 0;
  for (const x of all) {
    if (x.charges.netPnl > 0) { streak++; maxStreak = Math.max(maxStreak, streak); }
    else streak = 0;
  }

  return {
    totalTrades: closed.length, wins, losses: closed.length - wins,
    winRate: (wins / closed.length * 100),
    totalGross, totalNet, totalChargesSum,
    avgHoldMs, bestTrade, worstTrade, maxStreak,
    totalBrokerage: all.reduce((s, x) => s + x.charges.brokerage, 0),
    totalStt: all.reduce((s, x) => s + x.charges.stt, 0),
    totalExchange: all.reduce((s, x) => s + x.charges.exchangeTurnover, 0),
    totalSebi: all.reduce((s, x) => s + x.charges.sebiCharges, 0),
    totalStampDuty: all.reduce((s, x) => s + x.charges.stampDuty, 0),
    totalGst: all.reduce((s, x) => s + x.charges.gst, 0),
  };
}

// ── Push notification helper ─────────────────────────────────────────────────
function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}
function sendPushNotif(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: '/candlescan/favicon.ico', tag: 'paper-trade' }); } catch { /* mobile fallback */ }
  }
}

// ── Styles (matching existing app patterns) ──────────────────────────────────
const inputStyle = {
  padding: '8px 10px', fontSize: 13, borderRadius: 6,
  border: '1px solid #e2e5eb', outline: 'none', boxSizing: 'border-box',
  color: '#1a1d26', background: '#fff',
};
const labelStyle = {
  fontSize: 10, color: '#8892a8', fontWeight: 600, marginBottom: 2,
  textTransform: 'uppercase', letterSpacing: 0.5,
};
const badgeStyle = (bg, color) => ({
  fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
  background: bg, color, whiteSpace: 'nowrap', display: 'inline-block',
});
const cardStyle = {
  padding: '10px 12px', borderRadius: 10, border: '1px solid #e2e5eb',
  background: '#fff', marginBottom: 8,
};

// ═══════════════════════════════════════════════════════════════════════════════
export default function PaperTradingPage({ savedIndex, indexOptions, engineVersion, scalpVariant }) {
  const allOptions = indexOptions || NSE_INDEX_OPTIONS;
  const [nseIndex, setNseIndex] = useState('TOP GAINERS (Live)');
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState([]);
  const [scanProgress, setScanProgress] = useState({ completed: 0, total: 0, current: '' });
  const [scanError, setScanError] = useState('');
  const [filter, setFilter] = useState('actionable');
  const [dirFilter, setDirFilter] = useState('any');
  const [searchQuery, setSearchQuery] = useState('');
  const abortRef = useRef(null);

  const [positionSize, setPositionSize] = useState(300000);
  const [margin, setMargin] = useState(true);

  // Trades — load from localStorage on mount
  const [trades, setTrades] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); return Array.isArray(s) ? s : []; }
    catch { return []; }
  });

  // Notifications
  const [notifications, setNotifications] = useState([]);

  // Persist trades
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(trades)); } catch { /* quota */ }
  }, [trades]);

  // Request notification permission on mount
  useEffect(() => { requestNotifPermission(); }, []);

  // Auto-dismiss notifications
  useEffect(() => {
    if (!notifications.length) return;
    const timer = setTimeout(() => {
      setNotifications(prev => prev.filter(n => Date.now() - n.createdAt < NOTIF_DISMISS_MS));
    }, NOTIF_DISMISS_MS + 500);
    return () => clearTimeout(timer);
  }, [notifications]);

  // ── Scanning ─────────────────────────────────────────────────────────────
  const startScan = useCallback(async () => {
    if (scanning) { abortRef.current?.abort(); return; }
    setScanning(true);
    setScanError('');
    setScanResults([]);
    setScanProgress({ completed: 0, total: 0, current: 'Loading index...' });

    try {
      const symbols = await fetchNseIndexSymbolList(nseIndex);
      if (!symbols?.length) { setScanError('Could not load index constituents.'); setScanning(false); return; }
      setScanProgress({ completed: 0, total: symbols.length, current: symbols[0] });

      let idxDir = null;
      if (engineVersion === 'scalp') {
        try { idxDir = await getIndexDirection(nseIndex); } catch { /* ignore */ }
      }

      const controller = new AbortController();
      abortRef.current = controller;

      const results = await batchScan({
        symbols, timeframe: engineVersion === 'scalp' ? '1m' : '5m',
        batchToken: getBatchToken(),
        engineFns: getEngineFns(engineVersion, scalpVariant),
        indexDirection: idxDir,
        onProgress: (completed, total, current) => setScanProgress({ completed, total, current }),
        signal: controller.signal,
      });
      setScanResults(results);
    } catch (e) {
      if (e?.name !== 'AbortError') setScanError(e?.message || String(e));
    } finally {
      setScanning(false);
      abortRef.current = null;
    }
  }, [scanning, nseIndex, engineVersion, scalpVariant]);

  // ── Enter trade ──────────────────────────────────────────────────────────
  const enterTrade = useCallback((r) => {
    const effectiveSize = margin ? positionSize * MARGIN_MULTIPLIER : positionSize;
    const shares = Math.floor(effectiveSize / r.entry);
    if (shares < 1) return;
    // Prevent duplicate active on same symbol
    if (trades.some(t => t.symbol === r.symbol && t.status === 'active')) return;

    const trade = {
      id: `${Date.now()}_${r.symbol}`,
      symbol: r.symbol, companyName: r.companyName || r.symbol,
      direction: r.direction, action: r.action,
      entry: r.entry, sl: r.sl, target: r.target,
      confidence: r.confidence, topPattern: r.topPattern, rr: r.rr,
      status: 'active',
      entryTime: Date.now(), exitTime: null, exitPrice: null, exitReason: null,
      currentPrice: r.entry, lastPollTime: Date.now(),
      shares,
    };
    setTrades(prev => [...prev, trade]);
  }, [trades, positionSize, margin]);

  // ── Close trade manually ─────────────────────────────────────────────────
  const closeTrade = useCallback((id, price, reason = 'MANUAL') => {
    setTrades(prev => prev.map(t => {
      if (t.id !== id || t.status !== 'active') return t;
      const exitPrice = price || t.currentPrice || t.entry;
      const closed = { ...t, status: 'closed', exitPrice, exitTime: Date.now(), exitReason: reason };
      const charges = computeCharges(closed);
      const pnlStr = charges ? fmtRs(charges.netPnl) : '';
      const msg = `${t.symbol} ${reason} at ${exitPrice.toFixed(2)} (${pnlStr})`;
      const type = reason === 'TARGET' ? 'success' : reason === 'SL' ? 'error' : 'warning';
      setNotifications(prev => [...prev, { id: Date.now(), message: msg, type, createdAt: Date.now() }]);

      // Push notification
      const pushTitle = reason === 'TARGET' ? `Target Hit: ${t.symbol}` : reason === 'SL' ? `Stop Loss: ${t.symbol}` : `Trade Closed: ${t.symbol}`;
      sendPushNotif(pushTitle, msg);

      return closed;
    }));
  }, []);

  // ── Price polling ────────────────────────────────────────────────────────
  const tradesRef = useRef(trades);
  tradesRef.current = trades;

  useEffect(() => {
    const activeTrades = trades.filter(t => t.status === 'active');
    if (!activeTrades.length) return;

    const poll = async () => {
      // Pause if tab hidden
      if (document.visibilityState === 'hidden') return;

      const current = tradesRef.current;
      const active = current.filter(t => t.status === 'active');
      if (!active.length) return;

      const updates = await Promise.allSettled(
        active.map(t => fetchYahooQuote(t.symbol.replace(/\.NS$/, '') + '.NS'))
      );

      setTrades(prev => prev.map(t => {
        if (t.status !== 'active') return t;
        const idx = active.findIndex(a => a.id === t.id);
        if (idx < 0) return t;

        const quote = updates[idx]?.value;
        const price = quote?.last;
        if (!price) return { ...t, lastPollTime: Date.now() };

        // Check SL/TARGET
        if (t.direction === 'long') {
          if (price <= t.sl) {
            setTimeout(() => closeTrade(t.id, t.sl, 'SL'), 0);
            return { ...t, currentPrice: price, lastPollTime: Date.now() };
          }
          if (price >= t.target) {
            setTimeout(() => closeTrade(t.id, t.target, 'TARGET'), 0);
            return { ...t, currentPrice: price, lastPollTime: Date.now() };
          }
        } else {
          if (price >= t.sl) {
            setTimeout(() => closeTrade(t.id, t.sl, 'SL'), 0);
            return { ...t, currentPrice: price, lastPollTime: Date.now() };
          }
          if (price <= t.target) {
            setTimeout(() => closeTrade(t.id, t.target, 'TARGET'), 0);
            return { ...t, currentPrice: price, lastPollTime: Date.now() };
          }
        }

        return { ...t, currentPrice: price, lastPollTime: Date.now() };
      }));
    };

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [trades.filter(t => t.status === 'active').map(t => t.id).join(','), closeTrade]);

  // ── Clear all ────────────────────────────────────────────────────────────
  const clearAll = () => {
    setTrades([]);
    setNotifications([]);
    setScanResults([]);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ok */ }
  };

  // ── Derived data ─────────────────────────────────────────────────────────
  const activeTrades = trades.filter(t => t.status === 'active');
  const closedTrades = trades.filter(t => t.status === 'closed');
  const summary = computeDaySummary(trades);
  const activeSymbols = new Set(activeTrades.map(t => t.symbol));

  // Filter scan results
  let filtered = scanResults;
  if (filter === 'actionable') filtered = filtered.filter(r => !['NO TRADE', 'WAIT'].includes(r.action));
  if (dirFilter === 'long') filtered = filtered.filter(r => r.direction === 'long');
  if (dirFilter === 'short') filtered = filtered.filter(r => r.direction === 'short');
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(r => r.symbol.toLowerCase().includes(q) || (r.companyName || '').toLowerCase().includes(q));
  }
  // Exclude already-active symbols
  filtered = filtered.filter(r => !activeSymbols.has(r.symbol));

  const pct = scanProgress.total > 0 ? (scanProgress.completed / scanProgress.total) * 100 : 0;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '0 0 32px' }}>

      {/* ── Controls ────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 10 }}>
        <div style={labelStyle}>Index</div>
        <select value={nseIndex} onChange={e => setNseIndex(e.target.value)}
          disabled={scanning} style={{ ...inputStyle, width: '100%', cursor: 'pointer' }}>
          {allOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 100px' }}>
          <div style={labelStyle}>Capital (yours)</div>
          <input type="number" value={positionSize || ''} onChange={e => setPositionSize(e.target.value === '' ? '' : +e.target.value)}
            onBlur={e => { if (!e.target.value) setPositionSize(300000); }}
            step={50000} min={50000} disabled={scanning} style={{ ...inputStyle, width: '100%' }} />
        </div>
        <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'flex-end', paddingBottom: 2 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 12 }}>
            <input type="checkbox" checked={margin} onChange={e => setMargin(e.target.checked)} disabled={scanning} />
            <span style={{ fontWeight: 600 }}>5x Margin</span>
          </label>
        </div>
      </div>

      {margin && (
        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 10, marginTop: -4 }}>
          Per trade: Rs.{((margin ? positionSize * MARGIN_MULTIPLIER : positionSize) / 100000).toFixed(1)}L
        </div>
      )}

      {/* Scan button */}
      <button type="button" onClick={startScan}
        style={{
          width: '100%', padding: '12px 0', fontSize: 14, fontWeight: 700,
          borderRadius: 10, border: 'none', cursor: 'pointer',
          background: scanning ? '#dc2626' : '#2563eb', color: '#fff', marginBottom: 12,
        }}>
        {scanning ? `Cancel (${scanProgress.completed}/${scanProgress.total})` : 'Scan Now'}
      </button>

      {/* Progress */}
      {scanning && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ height: 6, borderRadius: 3, background: '#e2e5eb', overflow: 'hidden', marginBottom: 4 }}>
            <div style={{ width: `${pct}%`, height: '100%', background: '#2563eb', borderRadius: 3, transition: 'width 0.3s' }} />
          </div>
          <div style={{ fontSize: 11, color: '#8892a8' }}>{scanProgress.current}</div>
        </div>
      )}

      {scanError && (
        <div style={{ padding: 12, borderRadius: 10, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 13, marginBottom: 12 }}>
          {scanError}
        </div>
      )}

      {/* ── Notifications ───────────────────────────────────────────── */}
      {notifications.filter(n => Date.now() - n.createdAt < NOTIF_DISMISS_MS).map(n => (
        <div key={n.id} onClick={() => setNotifications(prev => prev.filter(x => x.id !== n.id))}
          style={{
            padding: '10px 12px', borderRadius: 10, marginBottom: 8, cursor: 'pointer',
            fontSize: 13, fontWeight: 600,
            background: n.type === 'success' ? '#f0fdf4' : n.type === 'error' ? '#fef2f2' : '#fffbeb',
            border: `1px solid ${n.type === 'success' ? '#bbf7d0' : n.type === 'error' ? '#fecaca' : '#fde68a'}`,
            color: n.type === 'success' ? '#166534' : n.type === 'error' ? '#991b1b' : '#92400e',
          }}>
          {n.message}
        </div>
      ))}

      {/* ── Active Trades ───────────────────────────────────────────── */}
      {activeTrades.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#16a34a', display: 'inline-block', animation: 'pulse 2s infinite' }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: '#1a1d26' }}>Active Trades ({activeTrades.length})</span>
            <span style={{ fontSize: 10, color: '#8892a8', marginLeft: 'auto' }}>polling every 30s</span>
          </div>

          {activeTrades.map(t => {
            const unrealPnl = t.direction === 'long'
              ? (t.currentPrice - t.entry) * t.shares
              : (t.entry - t.currentPrice) * t.shares;
            const pnlPct = ((t.currentPrice - t.entry) / t.entry * 100 * (t.direction === 'long' ? 1 : -1));
            const elapsed = Date.now() - t.entryTime;

            return (
              <div key={t.id} style={{ ...cardStyle, borderLeft: `3px solid ${unrealPnl >= 0 ? '#16a34a' : '#dc2626'}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <div>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{t.symbol}</span>
                    <span style={{ ...badgeStyle(actionBg(t.direction), actionColor(t.direction)), marginLeft: 6 }}>
                      {t.direction.toUpperCase()}
                    </span>
                  </div>
                  <div style={{ fontFamily: mono, fontSize: 15, fontWeight: 700, color: unrealPnl >= 0 ? '#16a34a' : '#dc2626' }}>
                    {fmtRs(unrealPnl)}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#6b7280', fontFamily: mono, marginBottom: 6 }}>
                  <span>Entry: {t.entry.toFixed(2)}</span>
                  <span style={{ color: '#dc2626' }}>SL: {t.sl.toFixed(2)}</span>
                  <span style={{ color: '#16a34a' }}>T: {t.target.toFixed(2)}</span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>
                    <span style={{ fontFamily: mono }}>LTP: {(t.currentPrice || 0).toFixed(2)}</span>
                    <span style={{ marginLeft: 8 }}>({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)</span>
                    <span style={{ marginLeft: 8 }}>{formatDuration(elapsed)} held</span>
                    <span style={{ marginLeft: 8 }}>{t.shares} shares</span>
                  </div>
                  <button type="button" onClick={() => closeTrade(t.id, t.currentPrice, 'MANUAL')}
                    style={{ fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, border: '1px solid #e2e5eb', background: '#fff', color: '#dc2626', cursor: 'pointer' }}>
                    Close
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Scan Results ────────────────────────────────────────────── */}
      {scanResults.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#1a1d26', marginBottom: 6 }}>
            Signals ({filtered.length})
          </div>

          {/* Filters */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
            {[['actionable', 'Actionable'], ['all', 'All']].map(([k, l]) => (
              <button key={k} onClick={() => setFilter(k)}
                style={{ fontSize: 11, fontWeight: 600, padding: '5px 10px', borderRadius: 6, border: filter === k ? 'none' : '1px solid #e2e5eb', background: filter === k ? '#2563eb' : '#fff', color: filter === k ? '#fff' : '#4a5068', cursor: 'pointer' }}>
                {l}
              </button>
            ))}
            <span style={{ width: 1, background: '#e2e5eb', margin: '0 2px' }} />
            {[['any', 'Any'], ['long', 'Long'], ['short', 'Short']].map(([k, l]) => (
              <button key={k} onClick={() => setDirFilter(k)}
                style={{ fontSize: 11, fontWeight: 600, padding: '5px 10px', borderRadius: 6, border: dirFilter === k ? 'none' : '1px solid #e2e5eb', background: dirFilter === k ? '#2563eb' : '#fff', color: dirFilter === k ? '#fff' : '#4a5068', cursor: 'pointer' }}>
                {l}
              </button>
            ))}
            <input placeholder="Search..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              style={{ ...inputStyle, flex: '1 1 80px', fontSize: 11, padding: '5px 8px' }} />
          </div>

          {filtered.map(r => (
            <div key={r.symbol} style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <div>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>{r.symbol}</span>
                  <span style={{ fontSize: 11, color: '#8892a8', marginLeft: 6 }}>{(r.companyName || '').slice(0, 20)}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={badgeStyle(actionBg(r.action), actionColor(r.action))}>{r.action}</span>
                  <span style={{ fontFamily: mono, fontSize: 12, fontWeight: 600 }}>{r.confidence}</span>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 11, color: '#6b7280', fontFamily: mono }}>
                  E:{r.entry?.toFixed(1)} SL:{r.sl?.toFixed(1)} T:{r.target?.toFixed(1)} R:R {r.rr?.toFixed(1)}
                </div>
                <button type="button" onClick={() => enterTrade(r)}
                  style={{ fontSize: 11, fontWeight: 700, padding: '5px 12px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer' }}>
                  Enter Trade
                </button>
              </div>
              <div style={{ fontSize: 10, color: '#8892a8', fontStyle: 'italic', marginTop: 2 }}>{r.topPattern}</div>
            </div>
          ))}

          {/* Rescan */}
          <button type="button" onClick={startScan}
            style={{ width: '100%', padding: '10px 0', fontSize: 13, fontWeight: 600, borderRadius: 8, border: '1px solid #2563eb', background: '#eff6ff', color: '#2563eb', cursor: 'pointer', marginTop: 4 }}>
            Rescan {nseIndex}
          </button>
        </div>
      )}

      {/* ── Closed Trades ───────────────────────────────────────────── */}
      {closedTrades.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#1a1d26', marginBottom: 8 }}>
            Closed Trades ({closedTrades.length})
          </div>

          {closedTrades.map(t => {
            const charges = computeCharges(t);
            if (!charges) return null;
            return <ClosedTradeCard key={t.id} trade={t} charges={charges} />;
          })}
        </div>
      )}

      {/* ── Day Summary ─────────────────────────────────────────────── */}
      {summary && <DaySummaryCard summary={summary} />}

      {/* ── Clear ───────────────────────────────────────────────────── */}
      {trades.length > 0 && (
        <button type="button" onClick={clearAll}
          style={{ width: '100%', padding: '10px 0', fontSize: 13, fontWeight: 600, borderRadius: 8, border: '1px solid #dc2626', background: '#fff', color: '#dc2626', cursor: 'pointer', marginTop: 8 }}>
          Clear &amp; Start Fresh
        </button>
      )}

      {/* ── Empty state ─────────────────────────────────────────────── */}
      {!trades.length && !scanResults.length && !scanning && (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: '#8892a8' }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>&#128200;</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#1a1d26', marginBottom: 4 }}>Paper Trading</div>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            Run a live scan, pick signals, and track simulated trades in real-time.
            <br />Prices update every 30 seconds. Push notifications on TARGET/SL hits.
          </div>
          <div style={{ fontSize: 11, color: '#d97706', marginTop: 12 }}>
            Prices delayed ~15 minutes (Yahoo Finance)
          </div>
        </div>
      )}

      {/* Pulse animation */}
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function ClosedTradeCard({ trade, charges }) {
  const [expanded, setExpanded] = useState(false);
  const elapsed = trade.exitTime - trade.entryTime;

  return (
    <div style={{ ...cardStyle, borderLeft: `3px solid ${reasonColor(trade.exitReason)}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <div>
          <span style={{ fontWeight: 700, fontSize: 13 }}>{trade.symbol}</span>
          <span style={badgeStyle(actionBg(trade.direction), actionColor(trade.direction))}> {trade.direction.toUpperCase()}</span>
          <span style={{ ...badgeStyle(reasonBg(trade.exitReason), reasonColor(trade.exitReason)), marginLeft: 4 }}>{trade.exitReason}</span>
        </div>
        <span style={{ fontFamily: mono, fontSize: 14, fontWeight: 700, color: charges.netPnl >= 0 ? '#16a34a' : '#dc2626' }}>
          {fmtRs(charges.netPnl)}
        </span>
      </div>

      <div style={{ fontSize: 11, color: '#6b7280', fontFamily: mono, marginBottom: 4 }}>
        {trade.entry.toFixed(2)} &rarr; {trade.exitPrice.toFixed(2)} &middot; {trade.shares} shares &middot; {formatDuration(elapsed)}
      </div>
      <div style={{ fontSize: 10, color: '#8892a8' }}>
        {formatTime(trade.entryTime)} &mdash; {formatTime(trade.exitTime)} &middot; {trade.topPattern}
      </div>

      <button type="button" onClick={() => setExpanded(!expanded)}
        style={{ fontSize: 10, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', fontWeight: 600 }}>
        {expanded ? 'Hide charges' : 'Show charges'}
      </button>

      {expanded && (
        <div style={{ fontSize: 11, color: '#6b7280', fontFamily: mono, background: '#f9fafb', borderRadius: 6, padding: '8px 10px', marginTop: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Gross P&amp;L</span><span>{fmtRs(charges.grossPnl)}</span></div>
          <div style={{ borderBottom: '1px solid #e5e7eb', margin: '4px 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Brokerage (2 x Rs.20)</span><span>-Rs.{charges.brokerage.toFixed(2)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>STT (0.025% sell)</span><span>-Rs.{charges.stt.toFixed(2)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Exchange turnover</span><span>-Rs.{charges.exchangeTurnover.toFixed(2)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>SEBI charges</span><span>-Rs.{charges.sebiCharges.toFixed(4)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Stamp duty (0.003%)</span><span>-Rs.{charges.stampDuty.toFixed(2)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>GST (18%)</span><span>-Rs.{charges.gst.toFixed(2)}</span></div>
          <div style={{ borderBottom: '1px solid #e5e7eb', margin: '4px 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: '#1a1d26' }}>
            <span>Net P&amp;L</span><span style={{ color: charges.netPnl >= 0 ? '#16a34a' : '#dc2626' }}>{fmtRs(charges.netPnl)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function DaySummaryCard({ summary }) {
  const s = summary;
  return (
    <div style={{ padding: '14px', borderRadius: 12, background: '#f8fafc', border: '1px solid #e2e5eb', marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#1a1d26', marginBottom: 10 }}>Day Summary</div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: '#8892a8', textTransform: 'uppercase', fontWeight: 600 }}>Trades</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{s.totalTrades}</div>
          <div style={{ fontSize: 10, color: '#6b7280' }}>{s.wins}W / {s.losses}L</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: '#8892a8', textTransform: 'uppercase', fontWeight: 600 }}>Win Rate</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: s.winRate >= 50 ? '#16a34a' : '#dc2626' }}>{s.winRate.toFixed(0)}%</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: '#8892a8', textTransform: 'uppercase', fontWeight: 600 }}>Net P&amp;L</div>
          <div style={{ fontSize: 16, fontWeight: 700, fontFamily: mono, color: s.totalNet >= 0 ? '#16a34a' : '#dc2626' }}>
            {fmtRs(s.totalNet)}
          </div>
        </div>
      </div>

      {/* Enriching extras */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6, fontSize: 11, color: '#6b7280', marginBottom: 10 }}>
        <div>Best trade: <span style={{ color: '#16a34a', fontWeight: 600, fontFamily: mono }}>{fmtRs(s.bestTrade)}</span></div>
        <div>Worst trade: <span style={{ color: '#dc2626', fontWeight: 600, fontFamily: mono }}>{fmtRs(s.worstTrade)}</span></div>
        <div>Avg hold: <span style={{ fontWeight: 600 }}>{formatDuration(s.avgHoldMs)}</span></div>
        <div>Win streak: <span style={{ fontWeight: 600 }}>{s.maxStreak}</span></div>
      </div>

      {/* Charge breakdown */}
      <div style={{ fontSize: 11, fontFamily: mono, background: '#fff', borderRadius: 8, padding: '8px 10px', border: '1px solid #e5e7eb' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}><span>Gross P&amp;L</span><span>{fmtRs(s.totalGross)}</span></div>
        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#8892a8' }}><span>Brokerage</span><span>-Rs.{s.totalBrokerage.toFixed(0)}</span></div>
        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#8892a8' }}><span>STT</span><span>-Rs.{s.totalStt.toFixed(2)}</span></div>
        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#8892a8' }}><span>Exchange</span><span>-Rs.{s.totalExchange.toFixed(2)}</span></div>
        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#8892a8' }}><span>SEBI</span><span>-Rs.{s.totalSebi.toFixed(4)}</span></div>
        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#8892a8' }}><span>Stamp duty</span><span>-Rs.{s.totalStampDuty.toFixed(2)}</span></div>
        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#8892a8' }}><span>GST</span><span>-Rs.{s.totalGst.toFixed(2)}</span></div>
        <div style={{ borderBottom: '1px solid #e5e7eb', margin: '4px 0' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: '#1a1d26' }}>
          <span>Total charges</span><span>-Rs.{s.totalChargesSum.toFixed(2)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginTop: 4 }}>
          <span>Net P&amp;L</span><span style={{ color: s.totalNet >= 0 ? '#16a34a' : '#dc2626' }}>{fmtRs(s.totalNet)}</span>
        </div>
      </div>
    </div>
  );
}
