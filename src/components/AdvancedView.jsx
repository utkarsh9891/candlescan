import SimpleView, { ScoreDetailsToggle } from './SimpleView.jsx';

const mono = "'SF Mono', Menlo, monospace";

const card = {
  padding: 16,
  borderRadius: 10,
  border: '1px solid #e2e5eb',
  background: '#fff',
  marginBottom: 12,
};

function QuoteMicroCard({ quote, last, sym }) {
  const bid = quote?.bid;
  const ask = quote?.ask;
  const hasBook = bid != null && ask != null && ask > 0 && bid > 0;

  if (!hasBook) return null;

  const spread = ask - bid;
  const spreadPct = ((spread / ask) * 100).toFixed(3);
  const price = last?.c;
  const midpoint = (bid + ask) / 2;
  const skew = price && midpoint ? ((price - midpoint) / midpoint * 100).toFixed(3) : null;

  // Relative range: (ask - bid) / bar range
  const barRange = last ? last.h - last.l : 0;
  const rangePct = barRange > 0 ? (spread / barRange) * 100 : 0;

  return (
    <div style={{ ...card, fontSize: 12, lineHeight: 1.6, fontFamily: mono }}>
      <div style={{ fontWeight: 700, marginBottom: 6, color: '#1a1d26', fontSize: 13, fontFamily: 'inherit' }}>
        Quote Microstructure
      </div>
      <div>Bid <b>{bid.toFixed(2)}</b> — Ask <b>{ask.toFixed(2)}</b></div>
      <div>Spread <b>{spread.toFixed(2)}</b> ({spreadPct}%)</div>
      {skew && <div>Price-to-mid skew: <b style={{ color: skew > 0 ? '#16a34a' : '#dc2626' }}>{skew}%</b></div>}
      {barRange > 0 && (
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

  return (
    <div>
      <SimpleView {...props} />

      <QuoteMicroCard quote={quote} last={last} sym={sym} />

      {/* Symbol + change */}
      <div style={{ ...card, fontSize: 13, color: '#4a5068' }}>
        <strong style={{ color: '#1a1d26' }}>{sym}</strong>
        {companyName && companyName !== sym ? ` — ${companyName}` : ''}
        <span style={{ fontFamily: mono, marginLeft: 8, color: changePct >= 0 ? '#16a34a' : '#dc2626' }}>
          {changePct >= 0 ? '\u25B2' : '\u25BC'} {changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%
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

      <ScoreDetailsToggle risk={risk} />
    </div>
  );
}
