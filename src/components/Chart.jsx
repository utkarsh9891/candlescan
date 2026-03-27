import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

const mono = "'SF Mono', Menlo, monospace";

const MIN_VISIBLE = 30;
const MAX_VISIBLE_CAP = 140;
const X_AXIS_HEIGHT = 22;

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

/* ── Helpers ──────────────────────────────────────────────────────── */

function countLatestSessionCandles(candles) {
  if (!candles?.length) return 0;
  // Use the last candle's date as "today's session" (handles weekends, holidays, after-hours)
  const lastTs = candles[candles.length - 1].t;
  const lastDate = new Date(lastTs * 1000);
  const sessionStart = new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate()).getTime() / 1000;
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].t >= sessionStart) count++;
    else break;
  }
  // If very few candles in current session (e.g., market just opened), include some from prior session
  if (count < MIN_VISIBLE && candles.length > count) {
    count = Math.min(candles.length, Math.max(MIN_VISIBLE, count + 20));
  }
  return count;
}

function formatTimestamp(ts, timeframe, prevTs) {
  const d = new Date(ts * 1000);
  if (timeframe === '1d') {
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  // Show date when it changes from previous label
  if (prevTs != null) {
    const prev = new Date(prevTs * 1000);
    if (prev.getDate() !== d.getDate() || prev.getMonth() !== d.getMonth()) {
      return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${time}`;
    }
  }
  return time;
}

/* ── Component ────────────────────────────────────────────────────── */

export default function Chart({
  candles,
  box,
  risk,
  height = 240,
  sym = '',
  timeframe = '5m',
  drawingMode = null,
  drawings = [],
  onDrawingComplete,
  onDrawingUpdate,
  patterns = [],
  highlightSignals = false,
}) {
  const [visibleCount, setVisibleCount] = useState(() => {
    const today = countLatestSessionCandles(candles);
    return today >= MIN_VISIBLE ? Math.min(today, MAX_VISIBLE_CAP) : Math.min(58, MAX_VISIBLE_CAP);
  });
  const [panOffset, setPanOffset] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const [pendingPoint, setPendingPoint] = useState(null);
  const [mousePos, setMousePos] = useState(null);

  // Measure container width on mount and resize
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setContainerWidth(el.clientWidth);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(el);
    else window.addEventListener('resize', measure);
    return () => { if (ro) ro.disconnect(); else window.removeEventListener('resize', measure); };
  }, []);
  const [draggingHLine, setDraggingHLine] = useState(null);

  // Touch state refs
  const touchRef = useRef({ startX: 0, startY: 0, lastDist: 0, fingers: 0, panStart: 0, countStart: 0 });
  // Track previous sym+length to detect when we need to recalculate zoom
  const prevKeyRef = useRef('');

  // Reset zoom to today's candles when symbol or data changes
  useEffect(() => {
    if (!candles?.length) return;
    const key = `${sym}:${candles.length}`;
    if (key === prevKeyRef.current) return;
    prevKeyRef.current = key;
    const today = countLatestSessionCandles(candles);
    const defaultCount = today >= MIN_VISIBLE ? Math.min(today, MAX_VISIBLE_CAP) : Math.min(58, candles.length, MAX_VISIBLE_CAP);
    setVisibleCount(defaultCount);
    setPanOffset(0);
  }, [sym, candles]);

  const maxVisible = Math.min(candles?.length || 0, MAX_VISIBLE_CAP);
  const floorBars = maxVisible <= 0 ? 0 : Math.max(1, Math.min(MIN_VISIBLE, maxVisible));
  const count = maxVisible <= 0 ? 0 : Math.min(maxVisible, Math.max(floorBars, visibleCount));

  useEffect(() => {
    if (maxVisible <= 0) return;
    const fl = Math.max(1, Math.min(MIN_VISIBLE, maxVisible));
    setVisibleCount((v) => Math.min(Math.max(v, fl), maxVisible));
  }, [maxVisible]);

  // Clamp panOffset
  const maxPan = Math.max(0, (candles?.length || 0) - count);
  const clampedPan = Math.min(panOffset, maxPan);

  const startIdx = Math.max(0, (candles?.length || 0) - count - clampedPan);
  const slice = count > 0 && candles?.length ? candles.slice(startIdx, startIdx + count) : [];
  const sliceStartIdx = startIdx;

  const zoomIn = useCallback(() => {
    setVisibleCount((v) => Math.max(floorBars, Math.floor(v * 0.72)));
  }, [floorBars]);

  const zoomOut = useCallback(() => {
    setVisibleCount((v) => Math.min(maxVisible, Math.ceil(v / 0.72)));
  }, [maxVisible]);

  const zoomFit = useCallback(() => {
    const today = countLatestSessionCandles(candles);
    const defaultCount = today >= MIN_VISIBLE ? Math.min(today, MAX_VISIBLE_CAP) : Math.min(58, maxVisible);
    setVisibleCount(defaultCount);
    setPanOffset(0);
  }, [maxVisible, candles]);

  /* ── Wheel: ctrl+wheel = zoom, regular wheel = pan ───────────── */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || maxVisible <= 0) return;
    const onWheelNative = (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // Pinch-to-zoom on trackpad (sends ctrl+wheel)
        const step = Math.max(2, Math.round(count * 0.1));
        const fl = Math.max(1, Math.min(MIN_VISIBLE, maxVisible));
        if (e.deltaY > 0) {
          setVisibleCount((v) => Math.min(maxVisible, v + step));
        } else {
          setVisibleCount((v) => Math.max(fl, v - step));
        }
      } else {
        // Regular scroll = pan left/right
        const step = Math.max(1, Math.round(count * 0.05));
        if (e.deltaX !== 0) {
          // Horizontal scroll
          setPanOffset((p) => Math.max(0, Math.min((candles?.length || 0) - count, p + (e.deltaX > 0 ? -step : step))));
        } else if (e.deltaY !== 0) {
          // Vertical scroll as pan
          setPanOffset((p) => Math.max(0, Math.min((candles?.length || 0) - count, p + (e.deltaY > 0 ? -step : step))));
        }
      }
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, [count, maxVisible, candles?.length]);

  /* ── Touch: pinch = zoom, swipe = pan ────────────────────────── */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const onTouchStart = (e) => {
      const t = touchRef.current;
      t.fingers = e.touches.length;
      if (e.touches.length === 1) {
        t.startX = e.touches[0].clientX;
        t.panStart = panOffset;
      } else if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        t.lastDist = Math.sqrt(dx * dx + dy * dy);
        t.countStart = visibleCount;
      }
    };

    const onTouchMove = (e) => {
      const t = touchRef.current;
      if (e.touches.length === 1 && t.fingers === 1) {
        // Pan
        const dx = e.touches[0].clientX - t.startX;
        const step = Math.round(dx / 8);
        const newPan = Math.max(0, Math.min((candles?.length || 0) - count, t.panStart + step));
        setPanOffset(newPan);
      } else if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (t.lastDist > 0) {
          const ratio = t.lastDist / dist;
          const newCount = Math.round(t.countStart * ratio);
          const fl = Math.max(1, Math.min(MIN_VISIBLE, maxVisible));
          setVisibleCount(Math.min(maxVisible, Math.max(fl, newCount)));
        }
      }
    };

    const onTouchEnd = () => {
      touchRef.current.fingers = 0;
    };

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [panOffset, visibleCount, count, maxVisible, candles?.length]);

  const canRender = slice.length > 0 && containerWidth > 0;

  let lo = Infinity, hi = -Infinity;
  for (const c of slice) {
    lo = Math.min(lo, c.l);
    hi = Math.max(hi, c.h);
  }
  if (box) {
    lo = Math.min(lo, box.low - box.manipulationZone);
    hi = Math.max(hi, box.high + box.manipulationZone);
  }
  if (risk) {
    lo = Math.min(lo, risk.sl, risk.target);
    hi = Math.max(hi, risk.sl, risk.target);
  }
  const pad = (hi - lo) * 0.06 || hi * 0.01;
  lo -= pad;
  hi += pad;
  const range = hi - lo || 1;

  // Chart width fills the container; candle width adapts
  const w = containerWidth > 0 ? containerWidth : 400;
  const h = height;
  const totalH = h + X_AXIS_HEIGHT;
  const leftGutter = 40;
  const chartW = w - leftGutter;

  const xFor = (i) => leftGutter + (i / Math.max(slice.length - 1, 1)) * chartW;
  const yFor = (p) => h - ((p - lo) / range) * (h - 8) - 4;
  const priceFor = (y) => lo + ((h - 4 - y) / (h - 8)) * range;
  const idxFor = (x) => Math.round(((x - leftGutter) / chartW) * (slice.length - 1));

  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((t) => lo + range * t);

  const atMinZoom = count <= floorBars;
  const atMaxZoom = count >= maxVisible;

  /* ── X-axis timestamp labels ──────────────────────────────────── */
  const xLabels = useMemo(() => {
    if (!slice.length) return [];
    const labels = [];
    const step = Math.max(1, Math.ceil(slice.length / 8));
    let prevTs = null;
    for (let i = 0; i < slice.length; i += step) {
      if (slice[i].t) {
        const isDateChange = prevTs != null && (() => {
          const cur = new Date(slice[i].t * 1000);
          const prev = new Date(prevTs * 1000);
          return cur.getDate() !== prev.getDate() || cur.getMonth() !== prev.getMonth();
        })();
        labels.push({
          idx: i,
          text: formatTimestamp(slice[i].t, timeframe, prevTs),
          isDateChange,
        });
        prevTs = slice[i].t;
      }
    }
    // Remove labels adjacent to date-change labels to avoid overlap
    const filtered = [];
    for (let i = 0; i < labels.length; i++) {
      const isNearDateChange =
        (i > 0 && labels[i - 1].isDateChange) ||
        (i < labels.length - 1 && labels[i + 1]?.isDateChange);
      if (labels[i].isDateChange || !isNearDateChange) {
        filtered.push(labels[i]);
      }
    }
    return filtered;
  }, [slice, timeframe]);

  /* ── Pattern highlight indices + labels ───────────────────────── */
  const { highlightSet, patternLabels } = useMemo(() => {
    if (!highlightSignals || !patterns?.length) return { highlightSet: new Set(), patternLabels: new Map() };
    const set = new Set();
    const labels = new Map(); // rel candle idx → { name, emoji, direction }
    for (const p of patterns) {
      if (p.candleIndices) {
        // Label goes on the last candle of the pattern
        const lastCi = p.candleIndices[p.candleIndices.length - 1];
        for (const ci of p.candleIndices) {
          const rel = ci - sliceStartIdx;
          if (rel >= 0 && rel < slice.length) {
            set.add(rel);
            // Only label the last candle of each pattern group
            if (ci === lastCi) {
              labels.set(rel, { name: p.name, emoji: p.emoji, direction: p.direction });
            }
          }
        }
      }
    }
    return { highlightSet: set, patternLabels: labels };
  }, [highlightSignals, patterns, sliceStartIdx, slice.length]);

  /* ── Drawing interaction ────────────────────────────────────────── */
  const getSvgCoords = (e) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const x = (e.clientX || e.touches?.[0]?.clientX || 0) - rect.left;
    const y = (e.clientY || e.touches?.[0]?.clientY || 0) - rect.top;
    return { x, y };
  };

  const handleSvgClick = (e) => {
    if (draggingHLine !== null) return;
    if (!drawingMode || !onDrawingComplete) return;
    const coords = getSvgCoords(e);
    if (!coords) return;

    const price = priceFor(coords.y);
    const idx = Math.max(0, Math.min(slice.length - 1, idxFor(coords.x)));

    if (drawingMode === 'hline') {
      onDrawingComplete({ type: 'hline', price });
      return;
    }

    if (drawingMode === 'box') {
      if (!pendingPoint) {
        setPendingPoint({ price, idx, time: slice[idx]?.t });
      } else {
        const i1 = Math.min(pendingPoint.idx, idx);
        const i2 = Math.max(pendingPoint.idx, idx);
        const pTop = Math.max(pendingPoint.price, price);
        const pBot = Math.min(pendingPoint.price, price);
        const t1 = slice[i1]?.t;
        const t2 = slice[i2]?.t;
        // Store directional change: from first click to second click
        const priceChange = price - pendingPoint.price;
        onDrawingComplete({
          type: 'box',
          priceTop: pTop,
          priceBot: pBot,
          idx1: i1,
          idx2: i2,
          time1: t1,
          time2: t2,
          candleCount: i2 - i1 + 1,
          startPrice: pendingPoint.price,
          endPrice: price,
          priceChange,
        });
        setPendingPoint(null);
      }
      return;
    }
  };

  // H-line drag handlers
  const handleHLineMouseDown = (e, drawIdx) => {
    e.stopPropagation();
    setDraggingHLine(drawIdx);
  };

  const handleSvgMouseMove = (e) => {
    const coords = getSvgCoords(e);
    if (!coords) return;
    setMousePos(coords);

    if (draggingHLine !== null && onDrawingUpdate) {
      const price = priceFor(coords.y);
      onDrawingUpdate(draggingHLine, { type: 'hline', price });
    }
  };

  const handleSvgMouseUp = () => {
    if (draggingHLine !== null) {
      setDraggingHLine(null);
    }
  };

  const handleSvgMouseLeave = () => {
    handleSvgMouseUp();
    setMousePos(null);
  };

  useEffect(() => {
    setPendingPoint(null);
  }, [drawingMode]);

  /* ── Box positioning ────────────────────────────────────────────── */
  let boxX = null, boxW = null, boxVisible = false;
  if (box && box.startIdx != null && box.endIdx != null) {
    const relStart = box.startIdx - sliceStartIdx;
    const relEnd = box.endIdx - sliceStartIdx;
    if (relEnd >= 0 && relStart < slice.length) {
      const clampStart = Math.max(0, relStart);
      const clampEnd = Math.min(slice.length - 1, relEnd);
      boxX = xFor(clampStart) - (chartW / slice.length) * 0.4;
      const boxEndX = xFor(clampEnd) + (chartW / slice.length) * 0.4;
      boxW = boxEndX - boxX;
      boxVisible = true;
    }
  } else if (box) {
    boxX = xFor(0);
    boxW = chartW;
    boxVisible = true;
  }

  // Live box preview while drawing
  const liveBox = pendingPoint && drawingMode === 'box' && mousePos
    ? {
        x: xFor(Math.min(pendingPoint.idx, Math.max(0, Math.min(slice.length - 1, idxFor(mousePos.x))))),
        y: yFor(Math.max(pendingPoint.price, priceFor(mousePos.y))),
        w: Math.abs(xFor(Math.max(0, Math.min(slice.length - 1, idxFor(mousePos.x)))) - xFor(pendingPoint.idx)),
        h: Math.abs(yFor(Math.min(pendingPoint.price, priceFor(mousePos.y))) - yFor(Math.max(pendingPoint.price, priceFor(mousePos.y)))),
      }
    : null;

  if (!canRender) {
    return (
      <div style={{ marginBottom: 12 }}>
        <div ref={wrapRef} style={{ borderRadius: 10, border: '1px solid #e2e5eb', background: '#fff', minHeight: slice.length ? height + X_AXIS_HEIGHT : 0 }} />
      </div>
    );
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
          Chart · {slice.length} bars
          {clampedPan > 0 && <span style={{ color: '#d97706', marginLeft: 4 }}>(panned)</span>}
          {drawingMode && (
            <span style={{ color: '#2563eb', marginLeft: 6 }}>
              [Drawing: {drawingMode}{pendingPoint ? ' — click end point' : ''}]
            </span>
          )}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button type="button" aria-label="Zoom in" title="Zoom in" onClick={zoomIn} disabled={atMinZoom}
            style={{ ...btnStyle, opacity: atMinZoom ? 0.45 : 1, cursor: atMinZoom ? 'not-allowed' : 'pointer' }}>+</button>
          <button type="button" aria-label="Zoom out" title="Zoom out" onClick={zoomOut} disabled={atMaxZoom}
            style={{ ...btnStyle, opacity: atMaxZoom ? 0.45 : 1, cursor: atMaxZoom ? 'not-allowed' : 'pointer' }}>−</button>
          <button type="button" aria-label="Reset zoom" title="Today" onClick={zoomFit}
            style={{ ...btnStyle, fontSize: 12, fontWeight: 600, color: '#2563eb' }}>Today</button>
        </div>
      </div>

      <div
        ref={wrapRef}
        style={{
          overflow: 'hidden',
          borderRadius: 10,
          border: '1px solid #e2e5eb',
          background: '#fff',
          cursor: draggingHLine !== null ? 'ns-resize' : drawingMode ? 'crosshair' : 'default',
          touchAction: 'none',
        }}
        role="img"
        aria-label={`Candlestick chart, ${slice.length} bars`}
      >
        <svg
          ref={svgRef}
          width={w}
          height={totalH}
          style={{ display: 'block' }}
          onClick={handleSvgClick}
          onMouseMove={handleSvgMouseMove}
          onMouseUp={handleSvgMouseUp}
          onMouseLeave={handleSvgMouseLeave}
        >
          {/* Grid */}
          {gridYs.map((gy, i) => (
            <g key={i}>
              <line x1={leftGutter} y1={yFor(gy)} x2={w} y2={yFor(gy)} stroke="#eef0f4" strokeWidth={1} />
              <text x={4} y={yFor(gy) + 4} fontSize={11} fill="#8892a8" fontFamily={mono}>{gy.toFixed(2)}</text>
            </g>
          ))}

          {/* Pattern highlight backgrounds + labels */}
          {highlightSignals && Array.from(highlightSet).map((i) => {
            const x = xFor(i);
            const bw = Math.max(2, chartW / slice.length - 1.5);
            const label = patternLabels.get(i);
            return (
              <g key={`hl-${i}`}>
                <rect
                  x={x - bw / 2 - 2}
                  y={4}
                  width={bw + 4}
                  height={h - 8}
                  fill="rgba(37, 99, 235, 0.08)"
                  rx={2}
                />
                {label && (() => {
                  const candleHigh = slice[i] ? yFor(slice[i].h) : 40;
                  const labelY = Math.max(12, candleHigh - 18);
                  const labelW = Math.max(50, label.name.length * 6 + 20);
                  const labelColor = label.direction === 'bullish' ? '#16a34a' : label.direction === 'bearish' ? '#dc2626' : '#2563eb';
                  // Clamp label X so it doesn't go off edges
                  const rawLabelX = x - labelW / 2;
                  const clampedLabelX = Math.max(leftGutter, Math.min(rawLabelX, w - labelW - 2));
                  return (
                    <g>
                      <rect
                        x={clampedLabelX}
                        y={labelY}
                        width={labelW}
                        height={16}
                        rx={4}
                        fill={labelColor}
                        opacity={0.9}
                      />
                      <text x={clampedLabelX + labelW / 2} y={labelY + 12} textAnchor="middle" fontSize={9} fill="#fff" fontFamily={mono} fontWeight={700}>
                        {label.emoji} {label.name}
                      </text>
                      {/* Arrow pointing down to candle */}
                      <line x1={x} y1={labelY + 16} x2={x} y2={labelY + 22} stroke={labelColor} strokeWidth={1.5} opacity={0.7} />
                    </g>
                  );
                })()}
              </g>
            );
          })}

          {/* Liquidity box — only when highlight is on */}
          {highlightSignals && box && boxVisible && (
            <g>
              <rect x={boxX} y={yFor(box.high)} width={boxW}
                height={Math.max(2, yFor(box.low) - yFor(box.high))}
                fill="rgba(37, 99, 235, 0.08)" stroke="#2563eb" strokeWidth={1} strokeDasharray="4 3" rx={2} />
              <rect x={boxX} y={yFor(box.high + box.manipulationZone)} width={boxW}
                height={Math.max(1, yFor(box.high) - yFor(box.high + box.manipulationZone))}
                fill="rgba(234, 88, 12, 0.12)" rx={1} />
              <rect x={boxX} y={yFor(box.low)} width={boxW}
                height={Math.max(1, yFor(box.low - box.manipulationZone) - yFor(box.low))}
                fill="rgba(234, 88, 12, 0.12)" rx={1} />
              {/* Label */}
              <text x={boxX + 3} y={yFor(box.high) - 3} fontSize={9} fill="#2563eb" fontFamily={mono} fontWeight={600} opacity={0.7}>
                Liquidity Box
              </text>
            </g>
          )}

          {highlightSignals && box && !boxVisible && (
            <g>
              <line x1={leftGutter} y1={yFor(box.high)} x2={w} y2={yFor(box.high)} stroke="#2563eb" strokeWidth={1} strokeDasharray="6 4" opacity={0.3} />
              <text x={leftGutter + 4} y={yFor(box.high) - 3} fontSize={9} fill="#2563eb" fontFamily={mono} opacity={0.5}>LiqBox Hi</text>
              <line x1={leftGutter} y1={yFor(box.low)} x2={w} y2={yFor(box.low)} stroke="#2563eb" strokeWidth={1} strokeDasharray="6 4" opacity={0.3} />
              <text x={leftGutter + 4} y={yFor(box.low) - 3} fontSize={9} fill="#2563eb" fontFamily={mono} opacity={0.5}>LiqBox Lo</text>
            </g>
          )}

          {/* Entry / SL / Target lines */}
          {risk && (risk.action === 'STRONG BUY' || risk.action === 'BUY' || risk.action === 'STRONG SHORT' || risk.action === 'SHORT') && (
            <g>
              {/* Entry — blue dashed */}
              <line x1={leftGutter} y1={yFor(risk.entry)} x2={w} y2={yFor(risk.entry)} stroke="#2563eb" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
              <rect x={leftGutter + 2} y={yFor(risk.entry) - 12} width={72} height={14} rx={3} fill="#2563eb" opacity={0.85} />
              <text x={leftGutter + 6} y={yFor(risk.entry) - 2} fontSize={9} fill="#fff" fontFamily={mono} fontWeight={700}>Entry {risk.entry.toFixed(0)}</text>
              {/* SL — red dashed */}
              <line x1={leftGutter} y1={yFor(risk.sl)} x2={w} y2={yFor(risk.sl)} stroke="#dc2626" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.7} />
              <rect x={leftGutter + 2} y={yFor(risk.sl) - 12} width={56} height={14} rx={3} fill="#dc2626" opacity={0.85} />
              <text x={leftGutter + 6} y={yFor(risk.sl) - 2} fontSize={9} fill="#fff" fontFamily={mono} fontWeight={700}>SL {risk.sl.toFixed(0)}</text>
              {/* Target — green dashed */}
              <line x1={leftGutter} y1={yFor(risk.target)} x2={w} y2={yFor(risk.target)} stroke="#16a34a" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.7} />
              <rect x={leftGutter + 2} y={yFor(risk.target) - 12} width={72} height={14} rx={3} fill="#16a34a" opacity={0.85} />
              <text x={leftGutter + 6} y={yFor(risk.target) - 2} fontSize={9} fill="#fff" fontFamily={mono} fontWeight={700}>Target {risk.target.toFixed(0)}</text>
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
            const highlighted = highlightSet.has(i);
            return (
              <g key={i}>
                <line x1={x} y1={yH} x2={x} y2={yL} stroke={fill} strokeWidth={1} />
                <rect
                  x={cx} y={top} width={bw} height={Math.max(1, bot - top)}
                  fill={fill}
                  stroke={last ? '#2563eb' : highlighted ? '#2563eb' : fill}
                  strokeWidth={last ? 2 : highlighted ? 1.5 : 0}
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
                <line x1={leftGutter} y1={y} x2={w} y2={y} stroke="#2563eb" strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />
                <text x={w - 4} y={y - 4} textAnchor="end" fontSize={11} fill="#2563eb" fontFamily={mono} fontWeight={600}>
                  {last.c.toFixed(2)}
                </text>
              </g>
            );
          })()}

          {/* User drawings */}
          {drawings.map((d, di) => {
            if (d.type === 'hline') {
              const y = yFor(d.price);
              const isDragging = draggingHLine === di;
              return (
                <g key={`d-${di}`}>
                  <line x1={leftGutter} y1={y} x2={w} y2={y} stroke="#8b5cf6" strokeWidth={1.5} strokeDasharray="6 3" />
                  <text x={leftGutter + 4} y={y - 3} fontSize={9} fill="#8b5cf6" fontFamily={mono}>{d.price.toFixed(2)}</text>
                  {/* Drag handle */}
                  <rect
                    x={leftGutter + 50}
                    y={y - 8}
                    width={20}
                    height={16}
                    fill={isDragging ? 'rgba(139, 92, 246, 0.3)' : 'rgba(139, 92, 246, 0.1)'}
                    stroke="#8b5cf6"
                    strokeWidth={1}
                    rx={3}
                    style={{ cursor: 'ns-resize' }}
                    onMouseDown={(e) => handleHLineMouseDown(e, di)}
                  />
                  <text x={leftGutter + 55} y={y + 4} fontSize={8} fill="#8b5cf6" fontFamily={mono} style={{ pointerEvents: 'none' }}>
                    ↕
                  </text>
                </g>
              );
            }
            if (d.type === 'box') {
              const bx = xFor(d.idx1);
              const bw = Math.max(2, xFor(d.idx2) - bx);
              const by = yFor(d.priceTop);
              const bh = Math.max(2, yFor(d.priceBot) - by);
              // Use directional change if available, otherwise absolute
              const change = d.priceChange != null ? d.priceChange : d.priceTop - d.priceBot;
              const basePrice = d.startPrice || d.priceBot;
              const changePct = ((change / basePrice) * 100).toFixed(2);
              const isPositive = change >= 0;
              const changeColor = isPositive ? '#16a34a' : '#dc2626';
              const timeText = d.time1 && d.time2
                ? `${formatTimestamp(d.time1, timeframe)} → ${formatTimestamp(d.time2, timeframe)}`
                : '';
              return (
                <g key={`d-${di}`}>
                  <rect x={bx} y={by} width={bw} height={bh}
                    fill={isPositive ? 'rgba(22, 163, 74, 0.06)' : 'rgba(220, 38, 38, 0.06)'}
                    stroke={isPositive ? '#16a34a' : '#dc2626'} strokeWidth={1.5} strokeDasharray="4 2" rx={2} />
                  {/* Box info */}
                  <text x={bx + 4} y={by + 12} fontSize={9} fill={changeColor} fontFamily={mono} fontWeight={600}>
                    {isPositive ? '+' : ''}{change.toFixed(2)} ({isPositive ? '+' : ''}{changePct}%)
                  </text>
                  {timeText && (
                    <text x={bx + 4} y={by + 22} fontSize={8} fill="#8892a8" fontFamily={mono}>
                      {timeText} · {d.candleCount || ''} bars
                    </text>
                  )}
                </g>
              );
            }
            return null;
          })}

          {/* Live box preview while drawing */}
          {liveBox && (
            <rect x={liveBox.x} y={liveBox.y} width={liveBox.w} height={liveBox.h}
              fill="rgba(139, 92, 246, 0.06)" stroke="#8b5cf6" strokeWidth={1} strokeDasharray="3 2" rx={2} />
          )}

          {/* Crosshair with price + time labels — always shown on hover */}
          {mousePos && mousePos.y > 0 && mousePos.y < h && mousePos.x >= leftGutter && (
            <g>
              {/* Horizontal crosshair */}
              <line x1={leftGutter} y1={mousePos.y} x2={w} y2={mousePos.y}
                stroke={drawingMode ? '#8b5cf6' : '#8892a8'} strokeWidth={0.5} strokeDasharray="2 2" opacity={0.5} />
              {/* Vertical crosshair */}
              {(() => {
                const ci = Math.max(0, Math.min(slice.length - 1, idxFor(mousePos.x)));
                return (
                  <line x1={xFor(ci)} y1={4} x2={xFor(ci)} y2={h}
                    stroke={drawingMode ? '#8b5cf6' : '#8892a8'} strokeWidth={0.5} strokeDasharray="2 2" opacity={0.4} />
                );
              })()}
              {/* Price label following cursor */}
              {(() => {
                const priceText = priceFor(mousePos.y).toFixed(2);
                const pillW = priceText.length * 7.5 + 12;
                const pillX = Math.min(mousePos.x + 12, w - pillW - 2);
                return (
                  <g>
                    <rect x={pillX} y={mousePos.y - 9} width={pillW} height={18} rx={3}
                      fill={drawingMode ? '#8b5cf6' : '#4a5068'} opacity={0.9} />
                    <text x={pillX + pillW / 2} y={mousePos.y + 4} textAnchor="middle" fontSize={10} fill="#fff" fontFamily={mono} fontWeight={600}>
                      {priceText}
                    </text>
                  </g>
                );
              })()}
              {/* Time label on bottom */}
              {(() => {
                const ci = Math.max(0, Math.min(slice.length - 1, idxFor(mousePos.x)));
                if (slice[ci]?.t) {
                  const label = formatTimestamp(slice[ci].t, timeframe);
                  const timePillW = Math.max(44, label.length * 7);
                  return (
                    <g>
                      <rect x={xFor(ci) - timePillW / 2} y={h + 2} width={timePillW} height={16} rx={3}
                        fill={drawingMode ? '#8b5cf6' : '#4a5068'} opacity={0.9} />
                      <text x={xFor(ci)} y={h + 14} textAnchor="middle" fontSize={10} fill="#fff" fontFamily={mono} fontWeight={600}>
                        {label}
                      </text>
                    </g>
                  );
                }
                return null;
              })()}
            </g>
          )}

          {/* Pending drawing point */}
          {pendingPoint && (
            <g>
              <circle cx={xFor(pendingPoint.idx)} cy={yFor(pendingPoint.price)} r={4}
                fill="#8b5cf6" stroke="#fff" strokeWidth={1.5} />
              <text x={xFor(pendingPoint.idx) + 8} y={yFor(pendingPoint.price) + 3} fontSize={9} fill="#8b5cf6" fontFamily={mono}>
                {pendingPoint.price.toFixed(2)}
              </text>
              {pendingPoint.time && (
                <text x={xFor(pendingPoint.idx)} y={h + 14} textAnchor="middle" fontSize={9} fill="#8b5cf6" fontFamily={mono}>
                  {formatTimestamp(pendingPoint.time, timeframe)}
                </text>
              )}
            </g>
          )}

          {/* X-axis timestamps */}
          {xLabels.map(({ idx, text, isDateChange }) => (
            <text
              key={`xl-${idx}`}
              x={xFor(idx)}
              y={h + 15}
              textAnchor="middle"
              fontSize={isDateChange ? 10 : 9}
              fontWeight={isDateChange ? 700 : 400}
              fill={isDateChange ? '#2563eb' : '#8892a8'}
              fontFamily={mono}
            >
              {text}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}
