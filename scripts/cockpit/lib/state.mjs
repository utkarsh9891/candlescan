/**
 * Cockpit state store — flat JSON, one file per IST trading day.
 *
 * Layout:
 *   ~/.candlescan/cockpit/state/
 *     2026-05-08.json   { signals: [...], trades: [...] }
 *     2026-05-09.json
 *     ...
 *
 * Atomic writes via temp+rename so a crash mid-write can't corrupt the
 * day file. Reads always go through the in-memory cache so we never hit
 * disk per-request from the HTTP server.
 *
 * Schema versioned via the top-level `v` field. Bumps in this module
 * should ship with a tiny migration that runs at load.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const STATE_DIR = path.join(os.homedir(), '.candlescan', 'cockpit', 'state');
const SCHEMA_VERSION = 1;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function todayIst() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function dayFilePath(day) {
  return path.join(STATE_DIR, `${day}.json`);
}

function emptyDay(day) {
  return { v: SCHEMA_VERSION, date: day, signals: [], trades: [] };
}

function loadDay(day) {
  const fp = dayFilePath(day);
  if (!fs.existsSync(fp)) return emptyDay(day);
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const obj = JSON.parse(raw);
    if (obj.v !== SCHEMA_VERSION) {
      // Future: run migrations. For v1 we simply overwrite older shapes.
      return emptyDay(day);
    }
    if (!Array.isArray(obj.signals)) obj.signals = [];
    if (!Array.isArray(obj.trades)) obj.trades = [];
    return obj;
  } catch {
    return emptyDay(day);
  }
}

function persistDay(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const fp = dayFilePath(state.date);
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, fp);
}

// Single in-memory state for the *current* IST day. The day rolls over
// at 00:00 IST; getCurrent() detects this and re-loads.
let current = null;

function getCurrent() {
  const today = todayIst();
  if (!current || current.date !== today) {
    current = loadDay(today);
  }
  return current;
}

export function save() {
  if (current) persistDay(current);
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

// ── Signals ────────────────────────────────────────────────────────

/**
 * @param {object} sig — must include symbol, barTs, pattern (used for dedup key).
 *                       Other fields: confidence, action, direction, entry, sl, target.
 * @returns {{ stored: boolean, id: string|null, signal: object|null }}
 *           stored=false when a duplicate was already present.
 */
export function recordSignal(sig) {
  const state = getCurrent();
  const dedupKey = `${sig.symbol}|${sig.barTs}|${sig.pattern}`;
  const existing = state.signals.find((s) => s.dedupKey === dedupKey);
  if (existing) return { stored: false, id: existing.id, signal: existing };
  const id = newId('sig');
  const stored = {
    id,
    dedupKey,
    createdAt: new Date().toISOString(),
    ...sig,
  };
  state.signals.push(stored);
  persistDay(state);
  return { stored: true, id, signal: stored };
}

export function getSignals(day = null) {
  const state = day ? loadDay(day) : getCurrent();
  return state.signals;
}

export function getSignalById(id) {
  const state = getCurrent();
  return state.signals.find((s) => s.id === id) || null;
}

// ── Trades ─────────────────────────────────────────────────────────

const POSITION_SIZE = 100000; // Rs 1L base; tier sizing layered later.
const MARGIN_MULTIPLIER = 5;
const TX_COST_PCT = 0.0002; // per side, per CLAUDE.md premium broker plan.

/**
 * Enter a paper trade for a signal. Idempotent on (signalId): if a trade
 * already exists for this signal, returns the existing one.
 */
export function enterTrade({ signalId, sym, barTs }) {
  const state = getCurrent();
  let signal = signalId
    ? state.signals.find((s) => s.id === signalId)
    : state.signals.find((s) => s.symbol === sym && String(s.barTs) === String(barTs));
  if (!signal) {
    return { ok: false, error: 'signal not found' };
  }
  const existing = state.trades.find((t) => t.signalId === signal.id);
  if (existing) return { ok: true, trade: existing, alreadyExisted: true };

  const entry = signal.entry;
  const sl = signal.sl;
  const target = signal.target;
  if (entry == null || sl == null || target == null) {
    return { ok: false, error: 'signal missing entry/sl/target' };
  }
  const exposure = POSITION_SIZE * MARGIN_MULTIPLIER;
  const shares = Math.floor(exposure / entry);
  if (shares < 1) {
    return { ok: false, error: 'shares < 1 — entry too high' };
  }

  const trade = {
    id: newId('tr'),
    signalId: signal.id,
    symbol: signal.symbol,
    direction: signal.direction,
    pattern: signal.pattern,
    confidence: signal.confidence,
    status: 'open',
    entry,
    sl,
    target,
    initialSl: sl, // remembered separately so the breakeven trail is visible.
    shares,
    positionSize: POSITION_SIZE,
    exposure,
    txCostPct: TX_COST_PCT,
    enteredAt: new Date().toISOString(),
    enteredAtTs: Math.floor(Date.now() / 1000),
    exitedAt: null,
    exitedAtTs: null,
    exitPrice: null,
    exitReason: null,
    grossPnl: null,
    txCost: null,
    netPnl: null,
    notes: [],
  };
  state.trades.push(trade);
  persistDay(state);
  return { ok: true, trade, alreadyExisted: false };
}

export function exitTrade({ tradeId, exitPrice, exitReason }) {
  const state = getCurrent();
  const trade = state.trades.find((t) => t.id === tradeId);
  if (!trade) return { ok: false, error: 'trade not found' };
  if (trade.status !== 'open') return { ok: false, error: 'trade already closed' };
  trade.status = 'closed';
  trade.exitPrice = exitPrice;
  trade.exitReason = exitReason;
  trade.exitedAt = new Date().toISOString();
  trade.exitedAtTs = Math.floor(Date.now() / 1000);
  const grossPnl =
    trade.direction === 'long'
      ? (exitPrice - trade.entry) * trade.shares
      : (trade.entry - exitPrice) * trade.shares;
  const notional = trade.entry * trade.shares + exitPrice * trade.shares;
  const txCost = notional * trade.txCostPct;
  trade.grossPnl = grossPnl;
  trade.txCost = txCost;
  trade.netPnl = grossPnl - txCost;
  persistDay(state);
  return { ok: true, trade };
}

/**
 * Tighten the SL on an open trade (used by the breakeven-trail rule).
 * Direction-aware: long-side raises only, short-side lowers only.
 */
export function trailSl({ tradeId, newSl, note }) {
  const state = getCurrent();
  const trade = state.trades.find((t) => t.id === tradeId);
  if (!trade || trade.status !== 'open') return false;
  const cur = trade.sl;
  if (trade.direction === 'long' && newSl > cur) {
    trade.sl = newSl;
    if (note) trade.notes.push({ ts: Date.now(), kind: 'trail', note, oldSl: cur, newSl });
    persistDay(state);
    return true;
  }
  if (trade.direction === 'short' && newSl < cur) {
    trade.sl = newSl;
    if (note) trade.notes.push({ ts: Date.now(), kind: 'trail', note, oldSl: cur, newSl });
    persistDay(state);
    return true;
  }
  return false;
}

export function getTrades(day = null) {
  const state = day ? loadDay(day) : getCurrent();
  return state.trades;
}

export function getOpenTrades() {
  return getCurrent().trades.filter((t) => t.status === 'open');
}

export function listAvailableDays() {
  if (!fs.existsSync(STATE_DIR)) return [];
  return fs
    .readdirSync(STATE_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

// Test/dev escape hatch.
export function _resetCache() {
  current = null;
}

export function _statePath() {
  return STATE_DIR;
}
