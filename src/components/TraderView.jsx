import RiskRing from './RiskRing.jsx';
import SimpleView from './SimpleView.jsx';

const card = {
  padding: 16,
  borderRadius: 10,
  border: '1px solid #e2e5eb',
  background: '#fff',
  marginBottom: 12,
};

export default function TraderView(props) {
  const { patterns, risk, box, candles, sym, companyName, changePct } = props;
  const bd = risk.breakdown;
  const last5 = candles.slice(-5);

  return (
    <div>
      <SimpleView {...props} />

      <div style={card}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10, color: '#1a1d26' }}>
          Risk breakdown
        </div>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <tbody>
            {[
              ['Signal clarity', bd.signalClarity, 25],
              ['Low noise', bd.lowNoise, 20],
              ['Risk : reward', bd.riskReward, 25],
              ['Pattern reliability', bd.patternReliability, 15],
              ['Confluence', bd.confluence, 15],
            ].map(([label, val, max]) => (
              <tr key={label}>
                <td style={{ padding: '6px 0', color: '#4a5068' }}>{label}</td>
                <td
                  style={{
                    textAlign: 'right',
                    fontFamily: "'SF Mono', Menlo, monospace",
                    fontWeight: 600,
                  }}
                >
                  {val} / {max}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
            <div>Breakout: {box.breakout}</div>
            <div>Trap: {box.trap}</div>
          </div>
        </div>
      )}

      <div style={card}>
        <div style={{ fontWeight: 700, marginBottom: 10, color: '#1a1d26' }}>Patterns</div>
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
