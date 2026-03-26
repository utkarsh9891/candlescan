import { useState, useEffect, useCallback, useRef } from 'react';

const mono = "'SF Mono', Menlo, monospace";

const MIN_VISIBLE = 12;
const MAX_VISIBLE_CAP = 140;
const DEFAULT_VISIBLE = 58;
const PX_PER_CANDLE = 12;
const MIN_CHART_WIDTH = 420;

const btnStyle = {
  minWidth: 36,
  minHeight: 34,
  padding: '0 10px',
  fontSize: 16,
  fontWeight: 600,
  lineHeight: 1,
  borderRadius: 8,
  border: '1px solid #e2e5eb',
  background: '#fff',
  color: '#1a1d26',
  cursor: 'pointer',
};

export default function Chart({ candles, box, height = 240, sym = '' }) {
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE);
  const wrapRef = useRef(null);

  useEffect(() => {
    setVisibleCount(DEFAULT_VISIBLE);
  }, [sym]);

  const maxVisible = Math.min(candles?.length || 0, MAX_VISIBLE_CAP);
  const floorBars =
    maxVisible <= 0 ? 0 : Math.max(1, Math.min(MIN_VISIBLE, maxVisible));
  const count =
    maxVisible <= 0
      ? 0
      : Math.min(maxVisible, Math.max(floorBars, visibleCount));

  useEffect(() => {
    if (maxVisible <= 0) return;
    const fl = Math.max(1, Math.min(MIN_VISIBLE, maxVisible));
    setVisibleCount((v) => Math.min(Math.max(v, fl), maxVisible));
  }, [maxVisible]);

  const slice =
    count > 0 && candles?.length ? candles.slice(-count) : [];

  const zoomIn = useCallback(() => {
    setVisibleCount((v) => Math.max(floorBars, Math.floor(v * 0.72)));
  }, [floorBars]);

  const zoomOut = useCallback(() => {
    setVisibleCount((v) => Math.min(maxVisible, Math.ceil(v / 0.72)));
  }, [maxVisible]);

  const zoomFit = useCallback(() => {
    setVisibleCount(Math.min(DEFAULT_VISIBLE, maxVisible));
  }, [maxVisible]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || maxVisible <= 0) return;
    const onWheelNative = (e) => {
      e.preventDefault();
      const step = Math.max(2, Math.round(count * 0.1));
      const fl = Math.max(1, Math.min(MIN_VISIBLE, maxVisible));
      if (e.deltaY > 0) {
        setVisibleCount((v) => Math.min(maxVisible, v + step));
      } else {
        setVisibleCount((v) => Math.max(fl, v - step));
      }
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, [count, maxVisible]);

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

  const w = Math.max(MIN_CHART_WIDTH, slice.length * PX_PER_CANDLE);
  const h = height;
  const leftGutter = 40;
  const chartW = w - leftGutter;

  const xFor = (i) => leftGutter + (i / Math.max(slice.length - 1, 1)) * chartW;
  const yFor = (p) => h - ((p - lo) / range) * (h - 8) - 4;

  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((t) => lo + range * t);

  const atMinZoom = count <= floorBars;
  const atMaxZoom = count >= maxVisible;

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 12, color: '#8892a8', fontWeight: 500 }}>
          Chart · last {slice.length} bars (scroll wheel zooms)
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            aria-label="Zoom in"
            title="Zoom in (fewer bars)"
            onClick={zoomIn}
            disabled={atMinZoom}
            style={{
              ...btnStyle,
              opacity: atMinZoom ? 0.45 : 1,
              cursor: atMinZoom ? 'not-allowed' : 'pointer',
            }}
          >
            +
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            title="Zoom out (more bars)"
            onClick={zoomOut}
            disabled={atMaxZoom}
            style={{
              ...btnStyle,
              opacity: atMaxZoom ? 0.45 : 1,
              cursor: atMaxZoom ? 'not-allowed' : 'pointer',
            }}
          >
            −
          </button>
          <button
            type="button"
            aria-label="Reset zoom"
            title="Default window"
            onClick={zoomFit}
            style={{
              ...btnStyle,
              fontSize: 12,
              fontWeight: 600,
              color: '#2563eb',
            }}
          >
            Reset
          </button>
        </div>
      </div>

      <div
        ref={wrapRef}
        style={{
          overflowX: 'auto',
          WebkitOverflowScrolling: 'touch',
          borderRadius: 10,
          border: '1px solid #e2e5eb',
          background: '#fff',
        }}
        role="img"
        aria-label={`Candlestick chart, ${slice.length} bars`}
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
    </div>
  );
}
