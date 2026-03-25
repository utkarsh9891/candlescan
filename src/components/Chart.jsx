const mono = "'SF Mono', Menlo, monospace";

export default function Chart({ candles, box, height = 140 }) {
  const slice = candles?.slice(-45) || [];
  if (!slice.length) return null;

  let lo = Infinity,
    hi = -Infinity;
  for (const c of slice) {
    lo = Math.min(lo, c.l);
    hi = Math.max(hi, c.h);
  }
  if (box) {
    lo = Math.min(lo, box.low - box.manipulationZone);
    hi = Math.max(hi, box.high + box.manipulationZone);
  }
  const pad = (hi - lo) * 0.06 || hi * 0.01;
  lo -= pad;
  hi += pad;
  const range = hi - lo || 1;

  const w = Math.max(320, slice.length * 8);
  const h = height;
  const leftGutter = 36;
  const chartW = w - leftGutter;

  const xFor = (i) => leftGutter + (i / Math.max(slice.length - 1, 1)) * chartW;
  const yFor = (p) => h - ((p - lo) / range) * (h - 8) - 4;

  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((t) => lo + range * t);

  return (
    <div
      style={{
        overflowX: 'auto',
        WebkitOverflowScrolling: 'touch',
        marginBottom: 12,
        borderRadius: 10,
        border: '1px solid #e2e5eb',
        background: '#fff',
      }}
    >
      <svg width={w} height={h + 18} style={{ display: 'block' }}>
        {gridYs.map((gy, i) => (
          <g key={i}>
            <line
              x1={leftGutter}
              y1={yFor(gy)}
              x2={w}
              y2={yFor(gy)}
              stroke="#eef0f4"
              strokeWidth={1}
            />
            <text
              x={4}
              y={yFor(gy) + 4}
              fontSize={10}
              fill="#8892a8"
              fontFamily={mono}
            >
              {gy.toFixed(2)}
            </text>
          </g>
        ))}

        {box && (
          <rect
            x={xFor(0)}
            y={yFor(box.high)}
            width={chartW}
            height={Math.max(2, yFor(box.low) - yFor(box.high))}
            fill="rgba(37, 99, 235, 0.08)"
            stroke="#2563eb"
            strokeWidth={1}
            strokeDasharray="4 3"
            rx={2}
          />
        )}

        {slice.map((c, i) => {
          const x = xFor(i);
          const bw = Math.max(2, chartW / slice.length - 1.5);
          const cx = x - bw / 2;
          const yH = yFor(c.h);
          const yL = yFor(c.l);
          const yO = yFor(c.o);
          const yC = yFor(c.c);
          const top = Math.min(yO, yC);
          const bot = Math.max(yO, yC);
          const bull = c.c >= c.o;
          const fill = bull ? '#16a34a' : '#dc2626';
          const last = i === slice.length - 1;
          return (
            <g key={i}>
              <line x1={x} y1={yH} x2={x} y2={yL} stroke={fill} strokeWidth={1} />
              <rect
                x={cx}
                y={top}
                width={bw}
                height={Math.max(1, bot - top)}
                fill={fill}
                stroke={last ? '#2563eb' : fill}
                strokeWidth={last ? 2 : 0}
                strokeDasharray={last ? '3 2' : undefined}
                rx={1}
              />
            </g>
          );
        })}

        {(() => {
          const last = slice[slice.length - 1];
          const y = yFor(last.c);
          return (
            <g>
              <line
                x1={leftGutter}
                y1={y}
                x2={w}
                y2={y}
                stroke="#2563eb"
                strokeWidth={1}
                strokeDasharray="4 3"
                opacity={0.7}
              />
              <text
                x={w - 4}
                y={y - 4}
                textAnchor="end"
                fontSize={11}
                fill="#2563eb"
                fontFamily={mono}
                fontWeight={600}
              >
                {last.c.toFixed(2)}
              </text>
            </g>
          );
        })()}
      </svg>
    </div>
  );
}
