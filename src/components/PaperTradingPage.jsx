/**
 * Paper Trading — live simulation with real-time price polling.
 *
 * Flow: Scan index → Pick signals → Track live → Get notified → See P&L → Repeat
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { NSE_INDEX_OPTIONS } from '../config/nseIndices.js';
import { fetchNseIndexSymbolList } from '../engine/nseIndexFetch.js';
import { batchScan } from '../engine/batchScan.js';
import { createFetchFn } from '../engine/dataSourceFetch.js';
import { fetchYahooQuote } from '../engine/yahooQuote.js';
import ToggleSwitch from './ToggleSwitch.jsx';
import { getGateToken } from '../utils/batchAuth.js';
import { getIndexDirection } from '../engine/indexDirection.js';
import { detectPatterns as detectPatternsScalp } from '../engine/patterns-scalp.js';
import { detectLiquidityBox as detectLiquidityBoxScalp } from '../engine/liquidityBox-scalp.js';
import { computeRiskScore as computeRiskScoreScalp } from '../engine/risk-scalp.js';
import { detectPatterns as detectPatternsV2 } from '../engine/patterns-v2.js';
import { detectLiquidityBox as detectLiquidityBoxV2 } from '../engine/liquidityBox-v2.js';
import { computeRiskScore as computeRiskScoreV2 } from '../engine/risk-v2.js';
import { detectPatterns as detectPatternsClassic } from '../engine/patterns-classic.js';
import { detectLiquidityBox as detectLiquidityBoxClassic } from '../engine/liquidityBox-classic.js';
import { computeRiskScore as computeRiskScoreClassic } from '../engine/risk-classic.js';
import { MARGIN_MULTIPLIER, CHARGES_REGULAR, CHARGES_PREMIUM, BROKER_PREMIUM_STORAGE_KEY } from '../data/marginData.js';

const mono = "'SF Mono', Menlo, monospace";
const STORAGE_KEY = 'candlescan_paper_trades';
const SETTINGS_KEY = 'candlescan_paper_settings';
const NOTIF_DISMISS_MS = 12000;

const POLL_OPTIONS = [
  { label: '1s', ms: 1000 },
  { label: '5s', ms: 5000 },
  { label: '10s', ms: 10000 },
  { label: '30s', ms: 30000 },
  { label: '1m', ms: 60000 },
];

function getEngineFns(engine) {
  if (engine === 'scalp') return {
    detectPatterns: detectPatternsScalp,
    detectLiquidityBox: detectLiquidityBoxScalp,
    computeRiskScore: computeRiskScoreScalp,
  };
  if (engine === 'v2') return { detectPatterns: detectPatternsV2, detectLiquidityBox: detectLiquidityBoxV2, computeRiskScore: computeRiskScoreV2 };
  return { detectPatterns: detectPatternsClassic, detectLiquidityBox: detectLiquidityBoxClassic, computeRiskScore: computeRiskScoreClassic };
}

// ── Color helpers — P&L drives green/red, direction is neutral ──────────────
function pnlColor(n) { return n >= 0 ? '#16a34a' : '#dc2626'; }
const dirBadge = (d) => ({
  fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
  background: '#eff6ff', color: '#2563eb', whiteSpace: 'nowrap', display: 'inline-block',
});
function actionBadge(a) {
  const isLong = a === 'STRONG BUY' || a === 'BUY';
  return {
    fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
    background: isLong ? '#f0fdf4' : a === 'STRONG SHORT' || a === 'SHORT' ? '#fef2f2' : '#f5f6f8',
    color: isLong ? '#16a34a' : a === 'STRONG SHORT' || a === 'SHORT' ? '#dc2626' : '#8892a8',
    whiteSpace: 'nowrap', display: 'inline-block',
  };
}
function reasonBadge(r) {
  const bg = r === 'TARGET' ? '#f0fdf4' : r === 'SL' ? '#fef2f2' : '#fffbeb';
  const c = r === 'TARGET' ? '#16a34a' : r === 'SL' ? '#dc2626' : '#d97706';
  return { fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: bg, color: c, display: 'inline-block' };
}

function formatTime(ts) { return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
function formatDuration(ms) { const m = Math.floor(ms / 60000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; }
function fmtRs(n) { return (n >= 0 ? '+' : '-') + 'Rs.' + Math.round(Math.abs(n)).toLocaleString('en-IN'); }

function computeCharges(trade, chargePlan = CHARGES_REGULAR) {
  const { entry, exitPrice, shares, direction } = trade;
  if (!exitPrice) return null;
  const C = chargePlan;
  const buyPrice = direction === 'long' ? entry : exitPrice;
  const sellPrice = direction === 'long' ? exitPrice : entry;
  const buyValue = buyPrice * shares, sellValue = sellPrice * shares, turnover = buyValue + sellValue;
  const brokerage = C.BROKERAGE_PER_ORDER * 2;
  const stt = sellValue * C.STT_SELL_PCT;
  const exchangeTurnover = turnover * C.EXCHANGE_TURNOVER_PCT;
  const sebiCharges = turnover * C.SEBI_PCT;
  const stampDuty = buyValue * C.STAMP_DUTY_BUY_PCT;
  const gst = (brokerage + exchangeTurnover + sebiCharges) * C.GST_PCT;
  const totalCharges = brokerage + stt + exchangeTurnover + sebiCharges + stampDuty + gst;
  const grossPnl = direction === 'long' ? (exitPrice - entry) * shares : (entry - exitPrice) * shares;
  return { buyValue, sellValue, turnover, brokerage, stt, exchangeTurnover, sebiCharges, stampDuty, gst, totalCharges, grossPnl, netPnl: grossPnl - totalCharges };
}

function computeDaySummary(allTrades, chargePlan) {
  const closed = allTrades.filter(t => t.status === 'closed' && t.exitPrice);
  if (!closed.length) return null;
  const all = closed.map(t => ({ trade: t, c: computeCharges(t, chargePlan) })).filter(x => x.c);
  const wins = all.filter(x => x.c.netPnl > 0).length;
  const holdTimes = all.map(x => x.trade.exitTime - x.trade.entryTime);
  let maxStreak = 0, streak = 0;
  for (const x of all) { if (x.c.netPnl > 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0; }
  return {
    totalTrades: closed.length, wins, losses: closed.length - wins,
    winRate: wins / closed.length * 100,
    totalGross: all.reduce((s, x) => s + x.c.grossPnl, 0),
    totalNet: all.reduce((s, x) => s + x.c.netPnl, 0),
    totalChargesSum: all.reduce((s, x) => s + x.c.totalCharges, 0),
    avgHoldMs: holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length,
    bestTrade: Math.max(...all.map(x => x.c.netPnl)),
    worstTrade: Math.min(...all.map(x => x.c.netPnl)),
    maxStreak,
    totalBrokerage: all.reduce((s, x) => s + x.c.brokerage, 0),
    totalStt: all.reduce((s, x) => s + x.c.stt, 0),
    totalExchange: all.reduce((s, x) => s + x.c.exchangeTurnover, 0),
    totalSebi: all.reduce((s, x) => s + x.c.sebiCharges, 0),
    totalStampDuty: all.reduce((s, x) => s + x.c.stampDuty, 0),
    totalGst: all.reduce((s, x) => s + x.c.gst, 0),
  };
}

function requestNotifPermission() { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); }
function sendPushNotif(title, body) {
  if ('Notification' in window && Notification.permission === 'granted')
    try { new Notification(title, { body, icon: '/candlescan/favicon.ico', tag: 'paper-trade' }); } catch {}
}

const inputStyle = { padding: '8px 10px', fontSize: 13, borderRadius: 6, border: '1px solid #e2e5eb', outline: 'none', boxSizing: 'border-box', color: '#1a1d26', background: '#fff' };
const labelStyle = { fontSize: 10, color: '#8892a8', fontWeight: 600, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.5 };
const cardStyle = { padding: '10px 12px', borderRadius: 10, border: '1px solid #e2e5eb', background: '#fff', marginBottom: 8 };
const sectionHeader = (onClick, open, label, count, rightEl) => (
  <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: open ? 8 : 0, cursor: 'pointer', userSelect: 'none' }}>
    <span style={{ fontSize: 11, color: '#8892a8', transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>&#9654;</span>
    <span style={{ fontSize: 13, fontWeight: 700, color: '#1a1d26' }}>{label} ({count})</span>
    {rightEl}
  </div>
);

// ═══════════════════════════════════════════════════════════════════════════════
export default function PaperTradingPage({ savedIndex, onIndexChange, indexOptions, engineVersion, dataSource }) {
  const allOptions = indexOptions || NSE_INDEX_OPTIONS;

  // Load saved settings
  const savedSettings = useRef((() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; } })());

  const nseIndex = savedIndex || 'NIFTY 200';
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState([]);
  const [scanProgress, setScanProgress] = useState({ completed: 0, total: 0, current: '' });
  const [scanError, setScanError] = useState('');
  const [filter, setFilter] = useState('actionable');
  const [dirFilter, setDirFilter] = useState('any');
  const [searchQuery, setSearchQuery] = useState('');
  const abortRef = useRef(null);

  const [capital, setCapital] = useState(savedSettings.current.capital || 300000);
  const [margin, setMargin] = useState(savedSettings.current.margin !== false);
  const [maxPositions, setMaxPositions] = useState(savedSettings.current.maxPositions || 1);
  const [pollMs, setPollMs] = useState(savedSettings.current.pollMs || 1000);
  const [premiumCharges, setPremiumCharges] = useState(() => {
    try { return localStorage.getItem(BROKER_PREMIUM_STORAGE_KEY) === 'true'; } catch { return false; }
  });

  const [trades, setTrades] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); return Array.isArray(s) ? s : []; } catch { return []; }
  });
  const [notifications, setNotifications] = useState([]);

  // Collapsible sections
  const [activeOpen, setActiveOpen] = useState(true);
  const [closedOpen, setClosedOpen] = useState(true);

  // Persist
  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(trades)); } catch {} }, [trades]);
  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ capital, margin, maxPositions, pollMs })); } catch {}
  }, [capital, margin, maxPositions, pollMs]);
  useEffect(() => { requestNotifPermission(); }, []);
  useEffect(() => {
    if (!notifications.length) return;
    const t = setTimeout(() => setNotifications(p => p.filter(n => Date.now() - n.createdAt < NOTIF_DISMISS_MS)), NOTIF_DISMISS_MS + 500);
    return () => clearTimeout(t);
  }, [notifications]);

  // ── Derived ──────────────────────────────────────────────────────────────
  const effectiveCapital = margin ? capital * MARGIN_MULTIPLIER : capital;
  const perTrade = Math.floor(effectiveCapital / maxPositions);
  const activeTrades = trades.filter(t => t.status === 'active');
  const closedTrades = trades.filter(t => t.status === 'closed');
  const chargePlan = premiumCharges ? CHARGES_PREMIUM : CHARGES_REGULAR;
  const summary = computeDaySummary(trades, chargePlan);
  const activeSymbols = new Set(activeTrades.map(t => t.symbol));
  const capitalInUse = activeTrades.reduce((s, t) => s + t.entry * t.shares, 0);
  const capitalFree = effectiveCapital - capitalInUse;
  const canEnterMore = activeTrades.length < maxPositions && capitalFree > 0;

  // ── Scan ─────────────────────────────────────────────────────────────────
  const startScan = useCallback(async () => {
    if (scanning) { abortRef.current?.abort(); return; }
    setScanning(true); setScanError(''); setScanResults([]);
    setScanProgress({ completed: 0, total: 0, current: 'Loading index...' });
    try {
      const symbols = await fetchNseIndexSymbolList(nseIndex);
      if (!symbols?.length) { setScanError('Could not load index constituents.'); setScanning(false); return; }
      setScanProgress({ completed: 0, total: symbols.length, current: symbols[0] });
      let idxDir = null;
      if (engineVersion === 'scalp') { try { idxDir = await getIndexDirection(nseIndex); } catch {} }
      const controller = new AbortController(); abortRef.current = controller;
      const results = await batchScan({
        symbols, timeframe: engineVersion === 'scalp' ? '1m' : '5m',
        gateToken: getGateToken(), engineFns: getEngineFns(engineVersion),
        indexDirection: idxDir,
        onProgress: (completed, total, current) => setScanProgress({ completed, total, current }),
        signal: controller.signal,
        fetchFn: createFetchFn(dataSource || 'yahoo'),
      });
      setScanResults(results);
    } catch (e) { if (e?.name !== 'AbortError') setScanError(e?.message || String(e)); }
    finally { setScanning(false); abortRef.current = null; }
  }, [scanning, nseIndex, engineVersion]);

  // ── Enter trade (capital-capped) ─────────────────────────────────────────
  const enterTrade = useCallback((r) => {
    if (!canEnterMore) return;
    if (trades.some(t => t.symbol === r.symbol && t.status === 'active')) return;
    const shares = Math.floor(perTrade / r.entry);
    if (shares < 1) return;
    setTrades(prev => [...prev, {
      id: `${Date.now()}_${r.symbol}`, symbol: r.symbol, companyName: r.companyName || r.symbol,
      direction: r.direction, action: r.action,
      entry: r.entry, sl: r.sl, target: r.target,
      confidence: r.confidence, topPattern: r.topPattern, rr: r.rr,
      status: 'active', entryTime: Date.now(), exitTime: null, exitPrice: null, exitReason: null,
      currentPrice: r.entry, lastPollTime: Date.now(), shares,
    }]);
  }, [canEnterMore, trades, perTrade]);

  // ── Close trade ──────────────────────────────────────────────────────────
  const chargePlanRef = useRef(premiumCharges ? CHARGES_PREMIUM : CHARGES_REGULAR);
  chargePlanRef.current = premiumCharges ? CHARGES_PREMIUM : CHARGES_REGULAR;

  const closeTrade = useCallback((id, price, reason = 'MANUAL') => {
    setTrades(prev => prev.map(t => {
      if (t.id !== id || t.status !== 'active') return t;
      const exitPrice = price || t.currentPrice || t.entry;
      const closed = { ...t, status: 'closed', exitPrice, exitTime: Date.now(), exitReason: reason };
      const ch = computeCharges(closed, chargePlanRef.current);
      const msg = `${t.symbol} ${reason} at ${exitPrice.toFixed(2)} (${ch ? fmtRs(ch.netPnl) : ''})`;
      const type = reason === 'TARGET' ? 'success' : reason === 'SL' ? 'error' : 'warning';
      setNotifications(prev => [...prev, { id: Date.now(), message: msg, type, createdAt: Date.now() }]);
      sendPushNotif(reason === 'TARGET' ? `Target Hit: ${t.symbol}` : reason === 'SL' ? `Stop Loss: ${t.symbol}` : `Trade Closed: ${t.symbol}`, msg);
      return closed;
    }));
  }, []);

  // ── Polling (background, non-blocking) ───────────────────────────────────
  const tradesRef = useRef(trades);
  tradesRef.current = trades;
  const closeTradeRef = useRef(closeTrade);
  closeTradeRef.current = closeTrade;
  const pollMsRef = useRef(pollMs);
  pollMsRef.current = pollMs;

  useEffect(() => {
    const activeIds = trades.filter(t => t.status === 'active').map(t => t.id).join(',');
    if (!activeIds) return;

    let timer;
    const poll = async () => {
      if (document.visibilityState === 'hidden') return;
      const current = tradesRef.current;
      const active = current.filter(t => t.status === 'active');
      if (!active.length) return;

      const updates = await Promise.allSettled(active.map(t => fetchYahooQuote(t.symbol.replace(/\.NS$/, '') + '.NS')));

      setTrades(prev => prev.map(t => {
        if (t.status !== 'active') return t;
        const idx = active.findIndex(a => a.id === t.id);
        if (idx < 0) return t;
        const price = updates[idx]?.value?.last;
        if (!price) return { ...t, lastPollTime: Date.now() };

        if (t.direction === 'long') {
          if (price <= t.sl) { setTimeout(() => closeTradeRef.current(t.id, t.sl, 'SL'), 0); }
          else if (price >= t.target) { setTimeout(() => closeTradeRef.current(t.id, t.target, 'TARGET'), 0); }
        } else {
          if (price >= t.sl) { setTimeout(() => closeTradeRef.current(t.id, t.sl, 'SL'), 0); }
          else if (price <= t.target) { setTimeout(() => closeTradeRef.current(t.id, t.target, 'TARGET'), 0); }
        }
        return { ...t, currentPrice: price, lastPollTime: Date.now() };
      }));
    };

    poll();
    timer = setInterval(poll, pollMsRef.current);
    return () => clearInterval(timer);
  }, [trades.filter(t => t.status === 'active').map(t => t.id).join(','), pollMs]);

  const clearAll = () => { setTrades([]); setNotifications([]); setScanResults([]); try { localStorage.removeItem(STORAGE_KEY); } catch {} };

  // Filter scan results
  let filtered = scanResults;
  if (filter === 'actionable') filtered = filtered.filter(r => !['NO TRADE', 'WAIT'].includes(r.action));
  if (dirFilter === 'long') filtered = filtered.filter(r => r.direction === 'long');
  if (dirFilter === 'short') filtered = filtered.filter(r => r.direction === 'short');
  if (searchQuery) { const q = searchQuery.toLowerCase(); filtered = filtered.filter(r => r.symbol.toLowerCase().includes(q) || (r.companyName || '').toLowerCase().includes(q)); }
  filtered = filtered.filter(r => !activeSymbols.has(r.symbol));
  const pct = scanProgress.total > 0 ? scanProgress.completed / scanProgress.total * 100 : 0;

  // ── RENDER ───────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '0 0 32px' }}>
      {/* Controls */}
      <div style={{ marginBottom: 10 }}>
        <div style={labelStyle}>Index</div>
        <select value={nseIndex} onChange={e => onIndexChange(e.target.value)} disabled={scanning} style={{ ...inputStyle, width: '100%', cursor: 'pointer' }}>
          {allOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 90px' }}>
          <div style={labelStyle}>Capital</div>
          <input type="number" value={capital || ''} onChange={e => setCapital(e.target.value === '' ? '' : +e.target.value)}
            onBlur={e => { if (!e.target.value) setCapital(300000); }} step={50000} min={50000} disabled={scanning} style={{ ...inputStyle, width: '100%' }} />
        </div>
        <div style={{ flex: '0 0 65px' }}>
          <div style={labelStyle}>Max Pos.</div>
          <select value={maxPositions} onChange={e => setMaxPositions(+e.target.value)} disabled={scanning} style={{ ...inputStyle, width: '100%', cursor: 'pointer' }}>
            {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>

      {/* Toggles row */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <ToggleSwitch checked={margin} onChange={setMargin} label="5x Margin (MIS)" compact disabled={scanning} />
        <ToggleSwitch checked={premiumCharges} onChange={(v) => { setPremiumCharges(v); try { localStorage.setItem(BROKER_PREMIUM_STORAGE_KEY, String(v)); } catch {} }} label="Broker Premium" compact />
        {premiumCharges && <span style={{ fontSize: 10, color: '#8892a8' }}>(lower exchange fees)</span>}
      </div>

      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 10, display: 'flex', gap: 12 }}>
        <span>Buying power: <b>Rs.{(effectiveCapital / 100000).toFixed(1)}L</b></span>
        <span>Per trade: <b>Rs.{(perTrade / 100000).toFixed(1)}L</b></span>
        {activeTrades.length > 0 && <span>Free: <b style={{ color: capitalFree > 0 ? '#16a34a' : '#dc2626' }}>Rs.{(capitalFree / 100000).toFixed(1)}L</b></span>}
      </div>

      <button type="button" onClick={startScan}
        style={{ width: '100%', padding: '12px 0', fontSize: 14, fontWeight: 700, borderRadius: 10, border: 'none', cursor: 'pointer', background: scanning ? '#dc2626' : '#2563eb', color: '#fff', marginBottom: 12 }}>
        {scanning ? `Cancel (${scanProgress.completed}/${scanProgress.total})` : 'Scan Now'}
      </button>

      {scanning && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ height: 6, borderRadius: 3, background: '#e2e5eb', overflow: 'hidden', marginBottom: 4 }}>
            <div style={{ width: `${pct}%`, height: '100%', background: '#2563eb', borderRadius: 3, transition: 'width 0.3s' }} />
          </div>
          <div style={{ fontSize: 11, color: '#8892a8' }}>{scanProgress.current}</div>
        </div>
      )}

      {scanError && <div style={{ padding: 12, borderRadius: 10, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 13, marginBottom: 12 }}>{scanError}</div>}

      {/* Notifications */}
      {notifications.filter(n => Date.now() - n.createdAt < NOTIF_DISMISS_MS).map(n => (
        <div key={n.id} onClick={() => setNotifications(p => p.filter(x => x.id !== n.id))}
          style={{ padding: '10px 12px', borderRadius: 10, marginBottom: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
            background: n.type === 'success' ? '#f0fdf4' : n.type === 'error' ? '#fef2f2' : '#fffbeb',
            border: `1px solid ${n.type === 'success' ? '#bbf7d0' : n.type === 'error' ? '#fecaca' : '#fde68a'}`,
            color: n.type === 'success' ? '#166534' : n.type === 'error' ? '#991b1b' : '#92400e' }}>
          {n.message}
        </div>
      ))}

      {/* ── Active Trades (collapsible) ──────────────────────────────── */}
      {activeTrades.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {sectionHeader(() => setActiveOpen(!activeOpen), activeOpen, 'Active Trades', activeTrades.length,
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }} onClick={e => e.stopPropagation()}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#16a34a', display: 'inline-block', animation: 'pulse 2s infinite' }} />
              <select value={pollMs} onChange={e => { e.stopPropagation(); setPollMs(+e.target.value); }}
                style={{ fontSize: 10, padding: '2px 4px', borderRadius: 4, border: '1px solid #e2e5eb', background: '#fff', color: '#4a5068', cursor: 'pointer' }}>
                {POLL_OPTIONS.map(o => <option key={o.ms} value={o.ms}>{o.label}</option>)}
              </select>
            </span>
          )}
          {activeOpen && activeTrades.map(t => {
            const unrealPnl = t.direction === 'long' ? (t.currentPrice - t.entry) * t.shares : (t.entry - t.currentPrice) * t.shares;
            const pnlPct = (t.currentPrice - t.entry) / t.entry * 100 * (t.direction === 'long' ? 1 : -1);
            const elapsed = Date.now() - t.entryTime;
            return (
              <div key={t.id} style={{ ...cardStyle, borderLeft: `3px solid ${pnlColor(unrealPnl)}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{t.symbol}</span>
                    <span style={dirBadge()}>{t.direction.toUpperCase()}</span>
                  </div>
                  <div style={{ fontFamily: mono, fontSize: 15, fontWeight: 700, color: pnlColor(unrealPnl) }}>{fmtRs(unrealPnl)}</div>
                </div>
                <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#6b7280', fontFamily: mono, marginBottom: 6 }}>
                  <span>Entry: {t.entry.toFixed(2)}</span>
                  <span>SL: {t.sl.toFixed(2)}</span>
                  <span>T: {t.target.toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>
                    <span style={{ fontFamily: mono }}>LTP: {(t.currentPrice || 0).toFixed(2)}</span>
                    <span style={{ marginLeft: 8, color: pnlColor(unrealPnl) }}>({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)</span>
                    <span style={{ marginLeft: 8 }}>{formatDuration(elapsed)}</span>
                  </div>
                  <button type="button" onClick={() => closeTrade(t.id, t.currentPrice, 'MANUAL')}
                    style={{ fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, border: '1px solid #e2e5eb', background: '#fff', color: '#dc2626', cursor: 'pointer' }}>Close</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Scan Results ─────────────────────────────────────────────── */}
      {scanResults.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#1a1d26', marginBottom: 6 }}>Signals ({filtered.length})</div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
            {[['actionable', 'Actionable'], ['all', 'All']].map(([k, l]) => (
              <button key={k} onClick={() => setFilter(k)} style={{ fontSize: 11, fontWeight: 600, padding: '5px 10px', borderRadius: 6, border: filter === k ? 'none' : '1px solid #e2e5eb', background: filter === k ? '#2563eb' : '#fff', color: filter === k ? '#fff' : '#4a5068', cursor: 'pointer' }}>{l}</button>
            ))}
            <span style={{ width: 1, background: '#e2e5eb', margin: '0 2px' }} />
            {[['any', 'Any'], ['long', 'Long'], ['short', 'Short']].map(([k, l]) => (
              <button key={k} onClick={() => setDirFilter(k)} style={{ fontSize: 11, fontWeight: 600, padding: '5px 10px', borderRadius: 6, border: dirFilter === k ? 'none' : '1px solid #e2e5eb', background: dirFilter === k ? '#2563eb' : '#fff', color: dirFilter === k ? '#fff' : '#4a5068', cursor: 'pointer' }}>{l}</button>
            ))}
            <input placeholder="Search..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} style={{ ...inputStyle, flex: '1 1 80px', fontSize: 11, padding: '5px 8px' }} />
          </div>
          {filtered.map(r => (
            <div key={r.symbol} style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <div><span style={{ fontWeight: 700, fontSize: 13 }}>{r.symbol}</span><span style={{ fontSize: 11, color: '#8892a8', marginLeft: 6 }}>{(r.companyName || '').slice(0, 20)}</span></div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span style={actionBadge(r.action)}>{r.action}</span><span style={{ fontFamily: mono, fontSize: 12, fontWeight: 600 }}>{r.confidence}</span></div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 11, color: '#6b7280', fontFamily: mono }}>E:{r.entry?.toFixed(1)} SL:{r.sl?.toFixed(1)} T:{r.target?.toFixed(1)} R:R {r.rr?.toFixed(1)}</div>
                <button type="button" onClick={() => enterTrade(r)} disabled={!canEnterMore}
                  style={{ fontSize: 11, fontWeight: 700, padding: '5px 12px', borderRadius: 6, border: 'none', background: canEnterMore ? '#2563eb' : '#9ca3af', color: '#fff', cursor: canEnterMore ? 'pointer' : 'not-allowed', opacity: canEnterMore ? 1 : 0.6 }}>
                  {canEnterMore ? 'Enter Trade' : 'Capital Full'}
                </button>
              </div>
              <div style={{ fontSize: 10, color: '#8892a8', fontStyle: 'italic', marginTop: 2 }}>{r.topPattern}</div>
            </div>
          ))}
          <button type="button" onClick={startScan} style={{ width: '100%', padding: '10px 0', fontSize: 13, fontWeight: 600, borderRadius: 8, border: '1px solid #2563eb', background: '#eff6ff', color: '#2563eb', cursor: 'pointer', marginTop: 4 }}>Rescan {nseIndex}</button>
        </div>
      )}

      {/* ── Closed Trades (collapsible) ──────────────────────────────── */}
      {closedTrades.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {sectionHeader(() => setClosedOpen(!closedOpen), closedOpen, 'Closed Trades', closedTrades.length, null)}
          {closedOpen && closedTrades.map(t => { const ch = computeCharges(t, chargePlan); return ch ? <ClosedTradeCard key={t.id} trade={t} charges={ch} /> : null; })}
        </div>
      )}

      {summary && <DaySummaryCard summary={summary} />}

      {trades.length > 0 && (
        <button type="button" onClick={clearAll} style={{ width: '100%', padding: '10px 0', fontSize: 13, fontWeight: 600, borderRadius: 8, border: '1px solid #dc2626', background: '#fff', color: '#dc2626', cursor: 'pointer', marginTop: 8 }}>Clear &amp; Start Fresh</button>
      )}

      {!trades.length && !scanResults.length && !scanning && (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: '#8892a8' }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>&#128200;</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#1a1d26', marginBottom: 4 }}>Paper Trading</div>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>Run a live scan, pick signals, and track simulated trades.<br />Prices auto-refresh. Push notifications on TARGET/SL hits.</div>
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 12 }}>Prices ~1-2 min delayed during market hours (Yahoo Finance API)</div>
        </div>
      )}
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────
function ClosedTradeCard({ trade, charges }) {
  const [expanded, setExpanded] = useState(false);
  const elapsed = trade.exitTime - trade.entryTime;
  return (
    <div style={{ ...cardStyle, borderLeft: `3px solid ${pnlColor(charges.netPnl)}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>{trade.symbol}</span>
          <span style={dirBadge()}>{trade.direction.toUpperCase()}</span>
          <span style={reasonBadge(trade.exitReason)}>{trade.exitReason}</span>
        </div>
        <span style={{ fontFamily: mono, fontSize: 14, fontWeight: 700, color: pnlColor(charges.netPnl) }}>{fmtRs(charges.netPnl)}</span>
      </div>
      <div style={{ fontSize: 11, color: '#6b7280', fontFamily: mono, marginBottom: 4 }}>{trade.entry.toFixed(2)} &rarr; {trade.exitPrice.toFixed(2)} &middot; {trade.shares} sh &middot; {formatDuration(elapsed)}</div>
      <div style={{ fontSize: 10, color: '#8892a8' }}>{formatTime(trade.entryTime)} &mdash; {formatTime(trade.exitTime)} &middot; {trade.topPattern}</div>
      <button type="button" onClick={() => setExpanded(!expanded)} style={{ fontSize: 10, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', fontWeight: 600 }}>{expanded ? 'Hide charges' : 'Show charges'}</button>
      {expanded && (
        <div style={{ fontSize: 11, color: '#6b7280', fontFamily: mono, background: '#f9fafb', borderRadius: 6, padding: '8px 10px', marginTop: 4 }}>
          <Row l="Gross P&L" r={fmtRs(charges.grossPnl)} />
          <div style={{ borderBottom: '1px solid #e5e7eb', margin: '4px 0' }} />
          <Row l="Brokerage (2×Rs.20)" r={`-Rs.${charges.brokerage.toFixed(0)}`} />
          <Row l="STT (0.025% sell)" r={`-Rs.${charges.stt.toFixed(2)}`} />
          <Row l="Exchange turnover" r={`-Rs.${charges.exchangeTurnover.toFixed(2)}`} />
          <Row l="SEBI charges" r={`-Rs.${charges.sebiCharges.toFixed(4)}`} />
          <Row l="Stamp duty" r={`-Rs.${charges.stampDuty.toFixed(2)}`} />
          <Row l="GST (18%)" r={`-Rs.${charges.gst.toFixed(2)}`} />
          <div style={{ borderBottom: '1px solid #e5e7eb', margin: '4px 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: pnlColor(charges.netPnl) }}><span>Net P&amp;L</span><span>{fmtRs(charges.netPnl)}</span></div>
        </div>
      )}
    </div>
  );
}

function Row({ l, r }) { return <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{l}</span><span>{r}</span></div>; }

function DaySummaryCard({ summary: s }) {
  return (
    <div style={{ padding: '14px', borderRadius: 12, background: '#f8fafc', border: '1px solid #e2e5eb', marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#1a1d26', marginBottom: 10 }}>Day Summary</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
        <Stat label="Trades" value={s.totalTrades} sub={`${s.wins}W / ${s.losses}L`} />
        <Stat label="Win Rate" value={`${s.winRate.toFixed(0)}%`} color={s.winRate >= 50 ? '#16a34a' : '#dc2626'} />
        <Stat label="Net P&L" value={fmtRs(s.totalNet)} color={pnlColor(s.totalNet)} mono />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6, fontSize: 11, color: '#6b7280', marginBottom: 10 }}>
        <div>Best: <span style={{ color: '#16a34a', fontWeight: 600, fontFamily: mono }}>{fmtRs(s.bestTrade)}</span></div>
        <div>Worst: <span style={{ color: '#dc2626', fontWeight: 600, fontFamily: mono }}>{fmtRs(s.worstTrade)}</span></div>
        <div>Avg hold: <b>{formatDuration(s.avgHoldMs)}</b></div>
        <div>Win streak: <b>{s.maxStreak}</b></div>
      </div>
      <div style={{ fontSize: 11, fontFamily: mono, background: '#fff', borderRadius: 8, padding: '8px 10px', border: '1px solid #e5e7eb' }}>
        <Row l="Gross P&L" r={fmtRs(s.totalGross)} />
        <Row l="Brokerage" r={`-Rs.${s.totalBrokerage.toFixed(0)}`} /><Row l="STT" r={`-Rs.${s.totalStt.toFixed(2)}`} />
        <Row l="Exchange" r={`-Rs.${s.totalExchange.toFixed(2)}`} /><Row l="SEBI" r={`-Rs.${s.totalSebi.toFixed(4)}`} />
        <Row l="Stamp duty" r={`-Rs.${s.totalStampDuty.toFixed(2)}`} /><Row l="GST" r={`-Rs.${s.totalGst.toFixed(2)}`} />
        <div style={{ borderBottom: '1px solid #e5e7eb', margin: '4px 0' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}><span>Total charges</span><span>-Rs.{s.totalChargesSum.toFixed(2)}</span></div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginTop: 4, color: pnlColor(s.totalNet) }}><span>Net P&amp;L</span><span>{fmtRs(s.totalNet)}</span></div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, color, mono: isMono }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 10, color: '#8892a8', textTransform: 'uppercase', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color, fontFamily: isMono ? mono : undefined }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: '#6b7280' }}>{sub}</div>}
    </div>
  );
}
