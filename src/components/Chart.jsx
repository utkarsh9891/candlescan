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

const toolBtnStyle = {
  ...btnStyle,
  fontSize: 12,
  fontWeight: 600,
  padding: '0 8px',
  minWidth: 'auto',
  minHeight: 30,
};

export default function Chart({
  candles,
  box,
  risk,
  height = 240,
  sym = '',
  drawingMode = null,
  drawings = [],
  onDrawingComplete,
}) {
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE);
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const [pendingPoint, setPendingPoint] = useState(null);

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

  const sliceStartIdx = candles?.length ? candles.length - slice.length : 0;

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
  // Include entry/sl/target in price range
  if (risk) {
    lo = Math.min(lo, risk.sl, risk.target);
    hi = Math.max(hi, risk.sl, risk.target);
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
  const priceFor = (y) => lo + ((h - 4 - y) / (h - 8)) * range;

  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((t) => lo + range * t);

  const atMinZoom = count <= floorBars;
  const atMaxZoom = count >= maxVisible;

  /* ── Drawing interaction ────────────────────────────────────── */
  const getSvgCoords = (e) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return { x, y };
  };

  const handleSvgClick = (e) => {
    if (!drawingMode || !onDrawingComplete) return;
    const coords = getSvgCoords(e);
    if (!coords) return;

    const price = priceFor(coords.y);
    // Find closest candle index
    const idx = Math.round(((coords.x - leftGutter) / chartW) * (slice.length - 1));
    const clampIdx = Math.max(0, Math.min(slice.length - 1, idx));

    if (drawingMode === 'hline') {
      onDrawingComplete({ type: 'hline', price });
      return;
    }

    if (drawingMode === 'trendline') {
      if (!pendingPoint) {
        setPendingPoint({ price, idx: clampIdx });
      } else {
        onDrawingComplete({
          type: 'trendline',
          price1: pendingPoint.price,
          idx1: pendingPoint.idx,
          price2: price,
          idx2: clampIdx,
        });
        setPendingPoint(null);
      }
      return;
    }

    if (drawingMode === 'box') {
      if (!pendingPoint) {
        setPendingPoint({ price, idx: clampIdx });
      } else {
        onDrawingComplete({
          type: 'box',
          priceTop: Math.max(pendingPoint.price, price),
          priceBot: Math.min(pendingPoint.price, price),
          idx1: Math.min(pendingPoint.idx, clampIdx),
          idx2: Math.max(pendingPoint.idx, clampIdx),
        });
        setPendingPoint(null);
      }
      return;
    }
  };

  // Clear pending point when drawing mode changes
  useEffect(() => {
    setPendingPoint(null);
  }, [drawingMode]);

  /* ── Box positioning ────────────────────────────────────────── */
  let boxX = null;
  let boxW = null;
  let boxVisible = false;
  if (box && box.startIdx != null && box.endIdx != null) {
    const relStart = box.startIdx - sliceStartIdx;
    const relEnd = box.endIdx - sliceStartIdx;
    // Check if box overlaps with visible slice
    if (relEnd >= 0 && relStart < slice.length) {
      const clampStart = Math.max(0, relStart);
      const clampEnd = Math.min(slice.length - 1, relEnd);
      boxX = xFor(clampStart) - (chartW / slice.length) * 0.4;
      const boxEndX = xFor(clampEnd) + (chartW / slice.length) * 0.4;
      boxW = boxEndX - boxX;
      boxVisible = true;
    }
  } else if (box) {
    // Legacy: no indices, span full width
    boxX = xFor(0);
    boxW = chartW;
    boxVisible = true;
  }

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
          Chart · last {slice.length} bars
          {drawingMode && (
            <span style={{ color: '#2563eb', marginLeft: 6 }}>
              [Drawing: {drawingMode}{pendingPoint ? ' — click end point' : ''}]
            </span>
          )}
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
          cursor: drawingMode ? 'crosshair' : 'default',
        }}
        role="img"
        aria-label={`Candlestick chart, ${slice.length} bars`}
      >
        <svg
          ref={svgRef}
          width={w}
          height={h + 18}
          style={{ display: 'block' }}
          onClick={handleSvgClick}
        >
          {/* Grid */}
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

          {/* Liquidity box */}
          {box && boxVisible && (
            <g>
              <rect
                x={boxX}
                y={yFor(box.high)}
                width={boxW}
                height={Math.max(2, yFor(box.low) - yFor(box.high))}
                fill="rgba(37, 99, 235, 0.08)"
                stroke="#2563eb"
                strokeWidth={1}
                strokeDasharray="4 3"
                rx={2}
              />
              {/* Manipulation zone — top band */}
              <rect
                x={boxX}
                y={yFor(box.high + box.manipulationZone)}
                width={boxW}
                height={Math.max(1, yFor(box.high) - yFor(box.high + box.manipulationZone))}
                fill="rgba(234, 88, 12, 0.12)"
                rx={1}
              />
              {/* Manipulation zone — bottom band */}
              <rect
                x={boxX}
                y={yFor(box.low)}
                width={boxW}
                height={Math.max(1, yFor(box.low - box.manipulationZone) - yFor(box.low))}
                fill="rgba(234, 88, 12, 0.12)"
                rx={1}
              />
            </g>
          )}

          {/* Box dashed lines when box exists but is outside visible range */}
          {box && !boxVisible && (
            <g>
              <line x1={leftGutter} y1={yFor(box.high)} x2={w} y2={yFor(box.high)} stroke="#2563eb" strokeWidth={1} strokeDasharray="6 4" opacity={0.4} />
              <line x1={leftGutter} y1={yFor(box.low)} x2={w} y2={yFor(box.low)} stroke="#2563eb" strokeWidth={1} strokeDasharray="6 4" opacity={0.4} />
            </g>
          )}

          {/* Entry / SL / Target lines */}
          {risk && (risk.action === 'STRONG BUY' || risk.action === 'BUY' || risk.action === 'STRONG SHORT' || risk.action === 'SHORT') && (
            <g>
              {/* Entry */}
              <line x1={leftGutter} y1={yFor(risk.entry)} x2={w} y2={yFor(risk.entry)} stroke="#2563eb" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
              <text x={w - 4} y={yFor(risk.entry) - 3} textAnchor="end" fontSize={9} fill="#2563eb" fontFamily={mono} fontWeight={600}>Entry {risk.entry.toFixed(2)}</text>

              {/* Stop Loss */}
              <line x1={leftGutter} y1={yFor(risk.sl)} x2={w} y2={yFor(risk.sl)} stroke="#dc2626" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
              <text x={w - 4} y={yFor(risk.sl) - 3} textAnchor="end" fontSize={9} fill="#dc2626" fontFamily={mono} fontWeight={600}>SL {risk.sl.toFixed(2)}</text>

              {/* Target */}
              <line x1={leftGutter} y1={yFor(risk.target)} x2={w} y2={yFor(risk.target)} stroke="#16a34a" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
              <text x={w - 4} y={yFor(risk.target) - 3} textAnchor="end" fontSize={9} fill="#16a34a" fontFamily={mono} fontWeight={600}>Target {risk.target.toFixed(2)}</text>
            </g>
          )}

          {/* Candles */}
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

          {/* Current price line */}
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

          {/* User drawings */}
          {drawings.map((d, di) => {
            if (d.type === 'hline') {
              const y = yFor(d.price);
              return (
                <g key={`d-${di}`}>
                  <line x1={leftGutter} y1={y} x2={w} y2={y} stroke="#8b5cf6" strokeWidth={1.5} strokeDasharray="6 3" />
                  <text x={leftGutter + 4} y={y - 3} fontSize={9} fill="#8b5cf6" fontFamily={mono}>{d.price.toFixed(2)}</text>
                </g>
              );
            }
            if (d.type === 'trendline') {
              return (
                <line
                  key={`d-${di}`}
                  x1={xFor(d.idx1)}
                  y1={yFor(d.price1)}
                  x2={xFor(d.idx2)}
                  y2={yFor(d.price2)}
                  stroke="#8b5cf6"
                  strokeWidth={1.5}
                />
              );
            }
            if (d.type === 'box') {
              return (
                <rect
                  key={`d-${di}`}
                  x={xFor(d.idx1)}
                  y={yFor(d.priceTop)}
                  width={Math.max(2, xFor(d.idx2) - xFor(d.idx1))}
                  height={Math.max(2, yFor(d.priceBot) - yFor(d.priceTop))}
                  fill="rgba(139, 92, 246, 0.08)"
                  stroke="#8b5cf6"
                  strokeWidth={1.5}
                  strokeDasharray="4 2"
                  rx={2}
                />
              );
            }
            return null;
          })}

          {/* Pending drawing point */}
          {pendingPoint && (
            <circle
              cx={xFor(pendingPoint.idx)}
              cy={yFor(pendingPoint.price)}
              r={4}
              fill="#8b5cf6"
              stroke="#fff"
              strokeWidth={1.5}
            />
          )}
        </svg>
      </div>
    </div>
  );
}
