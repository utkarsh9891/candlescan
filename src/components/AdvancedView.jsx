import { useEffect, useState } from 'react';
import SimpleView, { ScoreDetailsToggle } from './SimpleView.jsx';

const mono = "'SF Mono', Menlo, monospace";

const card = {
  padding: 16,
  borderRadius: 10,
  border: '1px solid #e2e5eb',
  background: '#fff',
  marginBottom: 12,
};

const timerBtn = (active) => ({
  minHeight: 28,
  padding: '0 8px',
  fontSize: 11,
  fontWeight: 600,
  borderRadius: 6,
  border: active ? 'none' : '1px solid #e2e5eb',
  background: active ? '#2563eb' : '#fff',
  color: active ? '#fff' : '#4a5068',
  cursor: 'pointer',
});

function QuoteMicroCard({ quote, last, sym }) {
  const bid = quote?.bid;
  const ask = quote?.ask;
  const hasBook = bid != null && ask != null && ask > 0 && bid > 0;

  // Hide entirely if no bid/ask data available (common for NSE stocks via Yahoo)
  if (!hasBook) return null;

  const spread = ask - bid;
  const rangePct =
    last && last.c > 0 ? ((last.h - last.l) / last.c) * 100 : null;

  return (
    <div style={{ ...card }}>
      <div style={{ fontWeight: 700, marginBottom: 8, color: '#1a1d26', fontSize: 13 }}>Quote · microstructure</div>
      <div style={{ fontSize: 12, lineHeight: 1.75, fontFamily: mono, color: '#4a5068' }}>
        <div>
          Bid <strong>{bid.toFixed(2)}</strong> ({quote.bidSize ?? '—'} size) · Ask{' '}
          <strong>{ask.toFixed(2)}</strong> ({quote.askSize ?? '—'} size)
        </div>
        <div>
          Spread <strong>{spread.toFixed(3)}</strong>
          {quote.last != null && (
            <span style={{ color: '#8892a8', marginLeft: 8 }}>Last {quote.last.toFixed(2)}</span>
          )}
        </div>
      </div>
      {(quote?.dayHigh != null || quote?.dayLow != null) && (
        <div style={{ fontSize: 11, fontFamily: mono, color: '#4a5068', marginBottom: 6 }}>
          Session H/L{' '}
          <strong>{quote.dayHigh?.toFixed(2) ?? '—'}</strong> / <strong>{quote.dayLow?.toFixed(2) ?? '—'}</strong>
        </div>
      )}
      {last && rangePct != null && (
        <div style={{ fontSize: 11, fontFamily: mono, color: '#4a5068' }}>
          Last bar range vs close: <strong>{rangePct.toFixed(3)}%</strong> ({sym})
        </div>
      )}
    </div>
  );
}

export default function AdvancedView(props) {
  const { patterns, box, candles, sym, companyName, changePct, risk, quote } = props;

  const last = candles.length ? candles[candles.length - 1] : null;

  /* ── Exit timer (from ScalpView) ─────────────────────────────── */
  const [durationMin, setDurationMin] = useState(null);
  const [leftSec, setLeftSec] = useState(null);

  // Request notification permission on first timer start
  const [notifGranted, setNotifGranted] = useState(
    typeof Notification !== 'undefined' && Notification.permission === 'granted'
  );

  useEffect(() => {
    if (leftSec == null || leftSec <= 0) return undefined;
    const t = setTimeout(() => setLeftSec((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearTimeout(t);
  }, [leftSec]);

  // Fire notification when timer reaches 0
  useEffect(() => {
    if (leftSec !== 0 || !durationMin) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;

    const action = risk?.action || 'TRADE';
    const price = last?.c ? last.c.toFixed(2) : '—';
    const sl = risk?.sl ? risk.sl.toFixed(2) : '—';
    const target = risk?.target ? risk.target.toFixed(2) : '—';

    new Notification(`EXIT NOW — ${sym}`, {
      body: `${action} | Price: ${price} | SL: ${sl} | Target: ${target} | ${durationMin}m timer expired`,
      icon: '/candlescan/icons/icon-192.svg',
      tag: 'candlescan-exit-timer',
      requireInteraction: true,
    });
  }, [leftSec, durationMin, sym, risk, last]);

  const startTimer = (m) => {
    setDurationMin(m);
    setLeftSec(m * 60);
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().then((p) => setNotifGranted(p === 'granted'));
    }
  };
  const stopTimer = () => { setDurationMin(null); setLeftSec(null); };

  const showTimer = leftSec != null;
  const mm = showTimer ? Math.floor(leftSec / 60) : 0;
  const ss = showTimer ? leftSec % 60 : 0;
  let timerColor = '#16a34a';
  if (leftSec < 60) timerColor = '#dc2626';
  else if (leftSec < 180) timerColor = '#d97706';

  const timerSlot = (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 5, marginTop: 8, marginBottom: showTimer ? 0 : 8,
        flexWrap: 'wrap', padding: '0 2px',
      }}>
        <span style={{ fontSize: 11, color: '#8892a8', fontWeight: 600 }}>Exit timer:</span>
        {[4, 5, 8, 10, 15].map((m) => (
          <button key={m} type="button" style={timerBtn(durationMin === m)} onClick={() => startTimer(m)}>
            {m}m
          </button>
        ))}
        {!notifGranted && typeof Notification !== 'undefined' && Notification.permission !== 'denied' && (
          <span style={{ fontSize: 10, color: '#d97706', marginLeft: 4 }}>
            (tap to enable alerts)
          </span>
        )}
      </div>

      {showTimer && (
        <div
          style={{
            marginTop: 6,
            marginBottom: 8,
            padding: 12,
            borderRadius: 10,
            border: `2px solid ${timerColor}`,
            background: leftSec < 60 ? '#fef2f2' : '#fff',
            textAlign: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <div style={{ fontSize: 11, color: '#8892a8' }}>{sym}</div>
            <div
              style={{
                fontSize: 28,
                fontWeight: 800,
                color: timerColor,
                fontFamily: mono,
                animation: leftSec < 60 ? 'pulse 1s infinite' : undefined,
              }}
            >
              {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
            </div>
            <button type="button" onClick={stopTimer} style={timerBtn(false)}>Stop</button>
          </div>
          {leftSec === 0 && (
            <div style={{ marginTop: 6, fontWeight: 800, color: '#dc2626', fontSize: 15 }}>
              EXIT NOW — {risk?.action} @ {last?.c?.toFixed(2)}
            </div>
          )}
        </div>
      )}
    </>
  );

  return (
    <div>
      <SimpleView {...props} beforeScoreDetails={timerSlot} />

      <QuoteMicroCard quote={quote} last={last} sym={sym} />

      {/* Symbol + change */}
      <div style={{ ...card, fontSize: 13, color: '#4a5068' }}>
        <strong style={{ color: '#1a1d26' }}>{sym}</strong>
        {companyName && companyName !== sym ? ` — ${companyName}` : ''}
        <span style={{ fontFamily: mono, marginLeft: 8, color: changePct >= 0 ? '#16a34a' : '#dc2626' }}>
          {changePct >= 0 ? '▲' : '▼'} {changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%
        </span>
      </div>

      {/* Liquidity box */}
      {box && (
        <div style={card}>
          <div style={{ fontWeight: 700, marginBottom: 8, color: '#1a1d26', fontSize: 13 }}>Liquidity Box</div>
          <div style={{ fontSize: 12, lineHeight: 1.7, fontFamily: mono }}>
            <div>High {box.high.toFixed(2)} — Low {box.low.toFixed(2)}</div>
            <div>Range {box.range.toFixed(3)} · Manip. ±{box.manipulationZone.toFixed(3)}</div>
            <div>
              Breakout:{' '}
              <span style={{ fontWeight: 700, color: box.breakout === 'bullish' ? '#16a34a' : box.breakout === 'bearish' ? '#dc2626' : '#8892a8' }}>
                {box.breakout}
              </span>
            </div>
            <div>
              Trap:{' '}
              <span style={{ fontWeight: 700, color: box.trap !== 'none' ? '#d97706' : '#8892a8' }}>
                {box.trap}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Patterns detail */}
      <div style={card}>
        <div style={{ fontWeight: 700, marginBottom: 8, color: '#1a1d26', fontSize: 13 }}>Patterns</div>
        {patterns.length === 0 && (
          <div style={{ fontSize: 12, color: '#8892a8' }}>No patterns detected (check signal filters)</div>
        )}
        {patterns.map((p) => (
          <div
            key={p.name + p.category}
            style={{ padding: '8px 0', borderBottom: '1px solid #eef0f4', fontSize: 12 }}
          >
            <div style={{ fontWeight: 700 }}>
              {p.emoji} {p.name}{' '}
              <span style={{ color: '#8892a8', fontWeight: 500 }}>({p.category})</span>
              <span style={{ fontFamily: mono, fontSize: 10, marginLeft: 8, color: '#4a5068' }}>
                str:{(p.strength * 100).toFixed(0)}% rel:{(p.reliability * 100).toFixed(0)}%
              </span>
            </div>
            <div style={{ color: '#4a5068', marginTop: 3 }}>{p.description}</div>
          </div>
        ))}
      </div>

      {/* Score details — at the very end (informational only) */}
      <ScoreDetailsToggle risk={risk} />

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.65; }
        }
      `}</style>
    </div>
  );
}
