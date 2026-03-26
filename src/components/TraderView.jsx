import SimpleView from './SimpleView.jsx';

const card = {
  padding: 16,
  borderRadius: 10,
  border: '1px solid #e2e5eb',
  background: '#fff',
  marginBottom: 12,
};

export default function TraderView(props) {
  const { patterns, box, candles, sym, companyName, changePct } = props;
  const last5 = candles.slice(-5);

  return (
    <div>
      <SimpleView {...props} />

      <div style={{ ...card, fontSize: 14, color: '#4a5068' }}>
        <strong style={{ color: '#1a1d26' }}>{sym}</strong>
        {companyName && companyName !== sym ? ` — ${companyName}` : ''}
        <span style={{ fontFamily: "'SF Mono', Menlo, monospace", marginLeft: 8 }}>
          Δ {changePct >= 0 ? '+' : ''}
          {changePct.toFixed(2)}%
        </span>
      </div>

      {box && (
        <div style={card}>
          <div style={{ fontWeight: 700, marginBottom: 8, color: '#1a1d26' }}>Liquidity box</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, fontFamily: "'SF Mono', Menlo, monospace" }}>
            <div>High {box.high.toFixed(2)} — Low {box.low.toFixed(2)}</div>
            <div>Range {box.range.toFixed(3)} · Manip. zone ±{box.manipulationZone.toFixed(3)}</div>
            <div>
              Breakout: <span style={{ fontWeight: 700, color: box.breakout === 'bullish' ? '#16a34a' : box.breakout === 'bearish' ? '#dc2626' : '#8892a8' }}>
                {box.breakout}
              </span>
            </div>
            <div>
              Trap: <span style={{ fontWeight: 700, color: box.trap !== 'none' ? '#d97706' : '#8892a8' }}>
                {box.trap}
              </span>
            </div>
          </div>
        </div>
      )}

      <div style={card}>
        <div style={{ fontWeight: 700, marginBottom: 10, color: '#1a1d26' }}>Patterns</div>
        {patterns.length === 0 && (
          <div style={{ fontSize: 13, color: '#8892a8' }}>No patterns detected (check signal filters)</div>
        )}
        {patterns.map((p) => (
          <div
            key={p.name + p.category}
            style={{
              padding: '10px 0',
              borderBottom: '1px solid #eef0f4',
              fontSize: 13,
            }}
          >
            <div style={{ fontWeight: 700 }}>
              {p.emoji} {p.name}{' '}
              <span style={{ color: '#8892a8', fontWeight: 500 }}>({p.category})</span>
              <span style={{ fontFamily: "'SF Mono', Menlo, monospace", fontSize: 11, marginLeft: 8, color: '#4a5068' }}>
                str:{(p.strength * 100).toFixed(0)}% rel:{(p.reliability * 100).toFixed(0)}%
              </span>
            </div>
            <div style={{ color: '#4a5068', marginTop: 4 }}>{p.description}</div>
          </div>
        ))}
      </div>

      <div style={card}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Last 5 candles</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ fontSize: 12, width: '100%', fontFamily: "'SF Mono', Menlo, monospace" }}>
            <thead>
              <tr style={{ color: '#8892a8' }}>
                <th style={{ textAlign: 'left' }}>O</th>
                <th>H</th>
                <th>L</th>
                <th>C</th>
                <th>V</th>
              </tr>
            </thead>
            <tbody>
              {last5.map((c, i) => (
                <tr key={i}>
                  <td>{c.o.toFixed(2)}</td>
                  <td>{c.h.toFixed(2)}</td>
                  <td>{c.l.toFixed(2)}</td>
                  <td>{c.c.toFixed(2)}</td>
                  <td>{(c.v / 1e3).toFixed(0)}k</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
