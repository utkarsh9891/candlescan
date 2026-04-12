/**
 * NoviceCards — sub-components used by NoviceModePage.
 *
 * Extracted to keep NoviceModePage under the file-read token limit.
 * These are pure presentational components: TradeNowCard,
 * WatchCard (with schedule button), PassphraseModal, Line,
 * EmptyPanel, SectionHeader, plus formatting helpers.
 */

import { useState } from 'react';
import ScheduleCheckButton from './ScheduleCheckButton.jsx';

const mono = "'SF Mono', Menlo, monospace";

// App owner defaults per CLAUDE.md
const DEFAULT_CAPITAL = 300000;
const MARGIN_MULT = 5;

// ── Formatting helpers ─────────────────────────────────────────────

export function rupees(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(Math.round(n));
  const s = String(abs);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  return `${sign}Rs ${grouped}`;
}

export function money(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  const rounded = Math.round(n / 100) * 100;
  return rupees(rounded);
}

export function price(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  return n.toFixed(n >= 1000 ? 0 : 1);
}

export function formatIstTime(ts) {
  if (!ts) return '';
  const d = new Date((ts + 19800) * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function computeSizing(r, capital = DEFAULT_CAPITAL) {
  if (!r?.entry || !r?.sl || !r?.target) return null;
  const exposure = capital * MARGIN_MULT;
  const shares = Math.floor(exposure / r.entry);
  const grossExposure = shares * r.entry;
  const expectedGain = shares * Math.abs(r.target - r.entry);
  const maxLoss = shares * Math.abs(r.entry - r.sl);
  return { exposure: grossExposure, shares, expectedGain, maxLoss };
}

// ── Sub-components ─────────────────────────────────────────────────

export function PassphraseModal({ onSubmit, onCancel }) {
  const [val, setVal] = useState('');
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20,
    }}>
      <div style={{
        background: '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 340,
        boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
      }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Unlock scanning</div>
        <div style={{ fontSize: 12, color: '#8892a8', marginBottom: 16 }}>
          Enter your passphrase once for the session.
        </div>
        <input
          type="password" autoFocus value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && val.trim() && onSubmit(val.trim())}
          placeholder="Passphrase"
          style={{
            width: '100%', padding: '10px 12px', fontSize: 14, borderRadius: 8,
            border: '1px solid #e2e5eb', outline: 'none', boxSizing: 'border-box', marginBottom: 14,
          }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={onCancel} style={{
            flex: 1, padding: '10px 0', fontSize: 13, fontWeight: 600, borderRadius: 8,
            border: '1px solid #e2e5eb', background: '#fff', color: '#4a5068', cursor: 'pointer',
          }}>Cancel</button>
          <button type="button"
            onClick={() => val.trim() && onSubmit(val.trim())}
            style={{
              flex: 1, padding: '10px 0', fontSize: 13, fontWeight: 600, borderRadius: 8,
              border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer',
              opacity: val.trim() ? 1 : 0.5,
            }}>Unlock</button>
        </div>
      </div>
    </div>
  );
}

export function Line({ label, value, color, strong, muted }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      gap: 8, padding: '3px 0',
    }}>
      <span style={{ fontSize: 12, color: muted ? '#8892a8' : '#4a5068' }}>{label}</span>
      <span style={{
        fontSize: strong ? 14 : 12,
        fontFamily: mono, fontWeight: strong ? 700 : 600,
        color: color || (muted ? '#8892a8' : '#1a1d26'),
      }}>{value}</span>
    </div>
  );
}

/**
 * Big actionable trade card — the "enter this now" recommendation.
 */
export function TradeNowCard({ r, capital, onTap, isNew }) {
  const long = r.direction === 'long' ||
               r.action === 'BUY' || r.action === 'STRONG BUY';
  const sizing = computeSizing(r, capital);
  const color = long ? '#16a34a' : '#dc2626';
  const bg = long ? '#f0fdf4' : '#fef2f2';
  const actionWord = long ? 'BUY' : 'SHORT';
  const exitPrefix = long ? 'Sell when it hits' : 'Cover when it hits';
  const stopPrefix = long ? 'Get out if it falls to' : 'Get out if it rises to';
  const directionExplain = long
    ? 'Price should go UP from here.'
    : 'Price should go DOWN from here.';

  return (
    <button
      type="button"
      onClick={() => onTap(r.symbol)}
      style={{
        width: '100%', textAlign: 'left', cursor: 'pointer',
        padding: 16, borderRadius: 14, marginBottom: 12,
        border: isNew ? `2px solid ${color}` : `1px solid ${long ? '#bbf7d0' : '#fecaca'}`,
        background: bg, display: 'block',
        boxShadow: isNew ? `0 0 0 3px ${color}22` : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {isNew && (
          <span style={{
            padding: '2px 7px', borderRadius: 4, fontSize: 9, fontWeight: 800,
            background: color, color: '#fff', letterSpacing: 0.5,
          }}>NEW</span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: '#1a1d26' }}>{r.symbol}</div>
          {r.companyName && r.companyName !== r.symbol && (
            <div style={{ fontSize: 11, color: '#8892a8', marginTop: 1 }}>
              {r.companyName.length > 32 ? r.companyName.slice(0, 32) + '…' : r.companyName}
            </div>
          )}
        </div>
        <div style={{
          padding: '6px 14px', borderRadius: 8, fontSize: 16, fontWeight: 800,
          background: color, color: '#fff', letterSpacing: 0.5,
        }}>{actionWord}</div>
      </div>

      <div style={{ fontSize: 12, color: '#4a5068', marginBottom: 10 }}>{directionExplain}</div>

      <div style={{
        background: '#fff', border: '1px solid #e2e5eb', borderRadius: 10,
        padding: 12, marginBottom: 10,
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a8', letterSpacing: 0.5, marginBottom: 6 }}>
          DO THIS NOW
        </div>
        <Line label={long ? 'Buy around' : 'Short around'} value={`Rs ${price(r.entry)} per share`} />
        {sizing && (
          <>
            <Line label="Quantity" value={`${sizing.shares.toLocaleString('en-IN')} shares`} />
            <Line label="You'll be exposed to" value={rupees(sizing.exposure)} muted />
          </>
        )}
        <div style={{ height: 1, background: '#f1f3f7', margin: '8px 0' }} />
        <Line label={exitPrefix} value={`Rs ${price(r.target)}`} color="#16a34a" strong />
        {sizing && <Line label="Profit if it works" value={`≈ ${money(sizing.expectedGain)}`} color="#16a34a" muted />}
        <div style={{ height: 1, background: '#f1f3f7', margin: '8px 0' }} />
        <Line label={stopPrefix} value={`Rs ${price(r.sl)}`} color="#dc2626" strong />
        {sizing && <Line label="Max loss if it fails" value={`≈ ${money(sizing.maxLoss)}`} color="#dc2626" muted />}
        <div style={{ height: 1, background: '#f1f3f7', margin: '8px 0' }} />
        <Line label="Time out either way by" value="11:00 AM (30-min max hold)" muted />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 10, color: '#8892a8' }}>
        {r.signalBarTs && <span style={{ fontFamily: mono }}>Signal fired at {formatIstTime(r.signalBarTs)}</span>}
        {r.validTillTs && <span style={{ fontFamily: mono }}>· valid till {formatIstTime(r.validTillTs)}</span>}
        {r.sector && <span>· {r.sector}</span>}
      </div>

      <div style={{ marginTop: 10, fontSize: 11, color: '#2563eb', fontWeight: 600 }}>
        Tap to open the full chart →
      </div>
    </button>
  );
}

/**
 * Watch list card — one line of status, a hint, schedule button, and
 * a tap target that opens the detail view.
 */
export function WatchCard({ r, onTap, category, scheduledChecks }) {
  const prox = r.proximityInfo;
  const long = prox?.direction === 'long' || (r.direction === 'long' && !prox);
  const color = long ? '#16a34a' : '#dc2626';

  const tierStyles = {
    imminent: { ring: '#fde68a', bg: '#fffbeb', pct: 0.85, tag: 'CLOSE' },
    building: { ring: '#e2e5eb', bg: '#ffffff', pct: 0.65, tag: 'WATCH' },
    early:    { ring: '#e2e5eb', bg: '#fafbfc', pct: 0.50, tag: 'EARLY' },
  };
  const ts = tierStyles[category] || tierStyles.building;

  const hint = prox?.hint || (category === 'imminent'
    ? 'Almost ready — check again shortly'
    : 'Still forming up');

  const pctRaw = prox?.proximity != null ? prox.proximity : ts.pct;
  const pct = Math.round(pctRaw * 100);

  return (
    <div
      role="button" tabIndex={0}
      onClick={() => onTap(r.symbol)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onTap(r.symbol); }}
      style={{
        width: '100%', textAlign: 'left', cursor: 'pointer',
        padding: 10, borderRadius: 10, marginBottom: 6,
        border: `1px solid ${ts.ring}`, background: ts.bg,
        display: 'block', boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#1a1d26' }}>{r.symbol}</span>
            <span style={{ padding: '1px 5px', borderRadius: 3, fontSize: 9, fontWeight: 700, background: long ? '#dcfce7' : '#fee2e2', color }}>
              {long ? 'LONG' : 'SHORT'}
            </span>
            <span style={{ padding: '1px 5px', borderRadius: 3, fontSize: 9, fontWeight: 700, background: '#eef2ff', color: '#4338ca' }}>
              {ts.tag}
            </span>
          </div>
          <div style={{ fontSize: 11, color: '#4a5068', marginTop: 3 }}>{hint}</div>
        </div>
        <div style={{ textAlign: 'right', minWidth: 46 }}>
          <div style={{ fontSize: 10, color: '#8892a8' }}>ready</div>
          <div style={{ fontSize: 14, fontWeight: 700, color, fontFamily: mono }}>{pct}%</div>
        </div>
      </div>

      <div style={{ height: 4, borderRadius: 2, background: '#e2e5eb', marginTop: 8, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color }} />
      </div>

      {scheduledChecks && (
        <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
          <ScheduleCheckButton
            scheduledChecks={scheduledChecks}
            symbol={r.symbol} company={r.companyName}
            direction={long ? 'long' : 'short'}
            beforeClass={category} beforeHint={hint} tier={category}
          />
        </div>
      )}
    </div>
  );
}

export function EmptyPanel({ text }) {
  return (
    <div style={{
      padding: 20, borderRadius: 10, background: '#f8fafc',
      border: '1px dashed #cbd5e1', textAlign: 'center',
      fontSize: 12, color: '#64748b',
    }}>
      {text}
    </div>
  );
}

export function SectionHeader({ title, count, color = '#1a1d26' }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      marginBottom: 8, marginTop: 20,
    }}>
      <div style={{ fontSize: 13, fontWeight: 800, color, letterSpacing: 0.3 }}>{title}</div>
      {count != null && (
        <div style={{
          fontSize: 10, fontWeight: 700, color: '#8892a8',
          background: '#f1f3f7', padding: '2px 8px', borderRadius: 10,
        }}>
          {count}
        </div>
      )}
    </div>
  );
}
