import { useState, useEffect, useCallback, useRef, useMemo, forwardRef, useImperativeHandle } from 'react';

const mono = "'SF Mono', Menlo, monospace";

const MIN_VISIBLE = 10;
const MAX_VISIBLE_CAP = 300;
const X_AXIS_HEIGHT = 22;

/** Default visible candle count per timeframe — keeps candle widths consistent. */
const DEFAULT_VISIBLE = {
  '1m': { mobile: 40, desktop: 60 },
  '5m': { mobile: 40, desktop: 60 },
  '15m': { mobile: 50, desktop: 80 },
  '25m': { mobile: 50, desktop: 80 },
  '30m': { mobile: 50, desktop: 80 },
  '1h': { mobile: 40, desktop: 60 },
  '1d': { mobile: 60, desktop: 120 },
};

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
      return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
  }
  return time;
}

/* ── Component ────────────────────────────────────────────────────── */

export default forwardRef(function Chart({
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
}, ref) {
  const [visibleCount, setVisibleCount] = useState(() => {
    const isMobile = window.innerWidth < 500;
    const tfDefaults = DEFAULT_VISIBLE[timeframe] || DEFAULT_VISIBLE['5m'];
    const cap = isMobile ? tfDefaults.mobile : tfDefaults.desktop;
    const have = candles?.length || 0;
    return have > 0 ? Math.min(cap, have, MAX_VISIBLE_CAP) : cap;
  });
  const [panOffset, setPanOffset] = useState(0);
  const panOffsetRef = useRef(0);
  const countRef = useRef(0);
  const visibleCountRef = useRef(visibleCount);
  const maxVisibleRef = useRef(0);
  const candlesLenRef = useRef(0);
  const [containerWidth, setContainerWidth] = useState(0);
  // Long-press crosshair state (mobile)
  const [crosshair, setCrosshair] = useState(null); // { x, y } or null
  const crosshairRef = useRef(null); // sync ref for use in touch handlers
  const longPressTimer = useRef(null);
  const longPressActive = useRef(false);
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const [pendingPoint, setPendingPoint] = useState(null);
  const [mousePos, setMousePos] = useState(null);
  const [tappedCandle, setTappedCandle] = useState(null); // { idx, candle } for mobile OHLCV info
  const [touchDrawPos, setTouchDrawPos] = useState(null); // touch crosshair position in drawing mode

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

  // Reset zoom to the default visible cap when symbol or data changes.
  // Use the full DEFAULT_VISIBLE cap regardless of time of day — this keeps
  // the chart view consistent whether market is open, mid-session, or closed.
  useEffect(() => {
    if (!candles?.length) return;
    const key = `${sym}:${candles.length}:${timeframe}`;
    if (key === prevKeyRef.current) return;
    prevKeyRef.current = key;
    const isMobile = (wrapRef.current?.clientWidth || window.innerWidth) < 500;
    const tfDefaults = DEFAULT_VISIBLE[timeframe] || DEFAULT_VISIBLE['5m'];
    const cap = isMobile ? tfDefaults.mobile : tfDefaults.desktop;
    const defaultCount = Math.min(cap, candles.length, MAX_VISIBLE_CAP);
    setVisibleCount(defaultCount);
    setPanOffset(0);
  }, [sym, candles, timeframe]);

  const maxVisible = Math.min(candles?.length || 0, MAX_VISIBLE_CAP);
  const floorBars = maxVisible <= 0 ? 0 : Math.max(1, Math.min(MIN_VISIBLE, maxVisible));
  const count = maxVisible <= 0 ? 0 : Math.min(maxVisible, Math.max(floorBars, visibleCount));

  // Keep refs in sync for event handlers (avoids stale closures)
  countRef.current = count;
  visibleCountRef.current = visibleCount;
  maxVisibleRef.current = maxVisible;
  crosshairRef.current = crosshair;
  candlesLenRef.current = candles?.length || 0;

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
    const isMobile = (wrapRef.current?.clientWidth || window.innerWidth) < 500;
    const tfDefaults = DEFAULT_VISIBLE[timeframe] || DEFAULT_VISIBLE['5m'];
    const cap = isMobile ? tfDefaults.mobile : tfDefaults.desktop;
    setVisibleCount(Math.min(cap, maxVisible));
    setPanOffset(0);
  }, [maxVisible, timeframe]);

  // Expose zoom controls to parent via ref
  useImperativeHandle(ref, () => ({
    zoomIn, zoomOut, zoomFit,
    get atMinZoom() { return count <= floorBars; },
    get atMaxZoom() { return count >= maxVisible; },
    get barCount() { return slice.length; },
  }), [zoomIn, zoomOut, zoomFit, count, floorBars, maxVisible, slice.length]);

  /* ── Wheel: ctrl+wheel = zoom, regular wheel = pan ───────────── */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheelNative = (e) => {
      const c = countRef.current;
      const mv = maxVisibleRef.current;
      const len = candlesLenRef.current;
      if (mv <= 0) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const step = Math.max(2, Math.round(c * 0.1));
        const fl = Math.max(1, Math.min(MIN_VISIBLE, mv));
        if (e.deltaY > 0) {
          setVisibleCount((v) => Math.min(mv, v + step));
        } else {
          setVisibleCount((v) => Math.max(fl, v - step));
        }
      } else if (e.deltaX !== 0) {
        e.preventDefault();
        const step = Math.max(1, Math.round(c * 0.05));
        setPanOffset((p) => Math.max(0, Math.min(len - c, p + (e.deltaX > 0 ? -step : step))));
      }
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, []);

  /* ── Touch: pinch = zoom, swipe = pan, long-press = crosshair ── */
  useEffect(() => { panOffsetRef.current = panOffset; }, [panOffset]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    // Crosshair behavior:
    // 1. Long-press (300ms hold, no move) → activates crosshair at finger position
    // 2. Drag while holding → moves crosshair
    // 3. Lift finger → crosshair STAYS
    // 4. Subsequent touch + drag → moves crosshair with OFFSET (finger doesn't snap
    //    to crosshair center — crosshair moves relative to drag distance, so you can
    //    position it precisely from a distance without your thumb covering it)
    // 5. Tap "+" → adds hline, dismisses crosshair
    // 6. Short tap (no drag) on chart → dismisses crosshair
    // While crosshair is active, chart pan is disabled.

    const onTouchStart = (e) => {
      const t = touchRef.current;
      t.fingers = e.touches.length;
      t.moved = false;
      t.crosshairDragging = false;

      if (e.touches.length === 1) {
        t.startX = e.touches[0].clientX;
        t.startY = e.touches[0].clientY;
        t.panStart = panOffsetRef.current;

        if (crosshairRef.current) {
          // Crosshair exists — store offset between finger and crosshair center
          // so subsequent drag moves crosshair by delta, not snapping to finger
          t.chOffsetX = crosshairRef.current.x - (e.touches[0].clientX - el.getBoundingClientRect().left);
          t.chOffsetY = crosshairRef.current.y - (e.touches[0].clientY - el.getBoundingClientRect().top);
          return; // Don't start long-press timer
        }

        // No crosshair — start long-press timer
        longPressActive.current = false;
        longPressTimer.current = setTimeout(() => {
          longPressActive.current = true;
          const rect = el.getBoundingClientRect();
          setCrosshair({
            x: e.touches[0].clientX - rect.left,
            y: e.touches[0].clientY - rect.top,
          });
        }, 300);
      } else if (e.touches.length === 2) {
        clearTimeout(longPressTimer.current);
        setCrosshair(null);
        longPressActive.current = false;
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        t.lastDist = Math.sqrt(dx * dx + dy * dy);
        t.countStart = visibleCountRef.current;
      }
    };

    const onTouchMove = (e) => {
      const t = touchRef.current;
      t.moved = true;

      if (e.touches.length === 1 && t.fingers === 1) {
        // If crosshair exists or long-press activated, move crosshair with offset
        if (longPressActive.current || crosshairRef.current) {
          e.preventDefault();
          t.crosshairDragging = true;
          const rect = el.getBoundingClientRect();
          const fingerX = e.touches[0].clientX - rect.left;
          const fingerY = e.touches[0].clientY - rect.top;

          if (longPressActive.current && !crosshairRef.current) {
            // First activation via long-press — snap to finger
            setCrosshair({ x: fingerX, y: fingerY });
          } else {
            // Subsequent drag — apply offset so crosshair doesn't jump to finger
            const ox = t.chOffsetX || 0;
            const oy = t.chOffsetY || 0;
            setCrosshair({ x: fingerX + ox, y: fingerY + oy });
          }
          longPressActive.current = true;
          return;
        }

        const dx = e.touches[0].clientX - t.startX;
        const dy = e.touches[0].clientY - t.startY;

        // Cancel long-press if moved
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
          clearTimeout(longPressTimer.current);
        }

        if (!drawingMode) {
          const step = Math.round(dx / 8);
          const len = candlesLenRef.current;
          const c = countRef.current;
          const newPan = Math.max(0, Math.min(len - c, t.panStart + step));
          setPanOffset(newPan);
        }
      } else if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const mv = maxVisibleRef.current;
        if (t.lastDist > 0) {
          const ratio = t.lastDist / dist;
          const newCount = Math.round(t.countStart * ratio);
          const fl = Math.max(1, Math.min(MIN_VISIBLE, mv));
          setVisibleCount(Math.min(mv, Math.max(fl, newCount)));
        }
      }
    };

    const onTouchEnd = () => {
      clearTimeout(longPressTimer.current);
      const t = touchRef.current;
      t.fingers = 0;

      // Short tap (no drag) while crosshair is showing → dismiss
      if (crosshairRef.current && !t.crosshairDragging && !t.moved) {
        setCrosshair(null);
        longPressActive.current = false;
        return;
      }

      // After drag, keep crosshair. Reset flags.
      longPressActive.current = false;
      t.crosshairDragging = false;
    };

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    return () => {
      clearTimeout(longPressTimer.current);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [drawingMode]);

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

  // Chart width fills the container; price axis on right
  const w = containerWidth > 0 ? containerWidth : 400;
  const h = height;
  const totalH = h + X_AXIS_HEIGHT;
  const leftPad = 4;
  const rightGutter = w < 500 ? 52 : 60; // price labels on right
  const chartW = w - leftPad - rightGutter;
  const chartRight = leftPad + chartW;

  // Inset so first/last candle bodies don't clip edges
  const candleInset = Math.max(4, Math.ceil((chartW / Math.max(slice.length, 1)) / 2));
  const plotLeft = leftPad + candleInset;
  const plotW = chartW - candleInset * 2;

  const xFor = (i) => plotLeft + (i / Math.max(slice.length - 1, 1)) * plotW;
  const yFor = (p) => h - ((p - lo) / range) * (h - 8) - 4;
  const priceFor = (y) => lo + ((h - 4 - y) / (h - 8)) * range;
  const idxFor = (x) => Math.round(((x - plotLeft) / plotW) * (slice.length - 1));

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
    return labels;
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

  // Touch handlers for SVG — drawing mode crosshair + candle tap info
  const handleSvgTouchStart = (e) => {
    if (e.touches.length !== 1) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = e.touches[0].clientX - rect.left;
    const y = e.touches[0].clientY - rect.top;

    if (drawingMode) {
      // In drawing mode: show crosshair at touch position
      e.preventDefault();
      e.stopPropagation();
      setTouchDrawPos({ x, y });
      setMousePos({ x, y });
    } else if (!crosshairRef.current) {
      // Not drawing and no crosshair: show OHLCV info for tapped candle
      const idx = Math.max(0, Math.min(slice.length - 1, idxFor(x)));
      if (slice[idx]) {
        setTappedCandle({ idx, candle: slice[idx] });
        setMousePos({ x, y });
      }
    }
  };

  const handleSvgTouchMove = (e) => {
    if (e.touches.length !== 1) return;
    if (!drawingMode) return;
    e.preventDefault();
    e.stopPropagation();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = e.touches[0].clientX - rect.left;
    const y = e.touches[0].clientY - rect.top;
    setTouchDrawPos({ x, y });
    setMousePos({ x, y });
  };

  const handleSvgTouchEnd = (e) => {
    if (drawingMode && touchDrawPos) {
      // Confirm drawing at current touch position
      e.preventDefault();
      const coords = touchDrawPos;
      const price = priceFor(coords.y);
      const idx = Math.max(0, Math.min(slice.length - 1, idxFor(coords.x)));

      if (drawingMode === 'hline' && onDrawingComplete) {
        onDrawingComplete({ type: 'hline', price });
      } else if (drawingMode === 'box' && onDrawingComplete) {
        if (!pendingPoint) {
          setPendingPoint({ price, idx, time: slice[idx]?.t });
        } else {
          const i1 = Math.min(pendingPoint.idx, idx);
          const i2 = Math.max(pendingPoint.idx, idx);
          const pTop = Math.max(pendingPoint.price, price);
          const pBot = Math.min(pendingPoint.price, price);
          const t1 = slice[i1]?.t;
          const t2 = slice[i2]?.t;
          const priceChange = price - pendingPoint.price;
          onDrawingComplete({
            type: 'box', priceTop: pTop, priceBot: pBot,
            idx1: i1, idx2: i2, time1: t1, time2: t2,
            candleCount: i2 - i1 + 1, startPrice: pendingPoint.price,
            endPrice: price, priceChange,
          });
          setPendingPoint(null);
        }
      }
      setTouchDrawPos(null);
      setMousePos(null);
    }
  };

  useEffect(() => {
    setPendingPoint(null);
    setTouchDrawPos(null);
    setTappedCandle(null);
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

  return (
    <div style={{ marginBottom: 12, userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}>
      {/* Drawing mode hint */}
      {canRender && drawingMode && (
        <div style={{ fontSize: 11, color: '#8b5cf6', fontWeight: 500, marginBottom: 4 }}>
          {drawingMode === 'hline' ? 'Tap to place line' : pendingPoint ? 'Tap end point' : 'Tap start point'}
        </div>
      )}

      {/* OHLCV bar — always visible. Shows tapped candle or last candle by default */}
      {canRender && (() => {
        const c = tappedCandle?.candle || slice[slice.length - 1];
        return c ? (
          <div style={{
            display: 'flex', gap: 5, alignItems: 'center',
            padding: '3px 6px', marginBottom: 4, borderRadius: 6,
            background: tappedCandle ? '#f0f4ff' : '#f8f9fb',
            border: `1px solid ${tappedCandle ? '#dbeafe' : '#e2e5eb'}`,
            fontSize: 10, fontFamily: mono, color: '#4a5068',
            whiteSpace: 'nowrap', overflow: 'hidden',
          }}>
            <span>O <b>{c.o.toFixed(2)}</b></span>
            <span>H <b>{c.h.toFixed(2)}</b></span>
            <span>L <b>{c.l.toFixed(2)}</b></span>
            <span>C <b style={{ color: c.c >= c.o ? '#16a34a' : '#dc2626' }}>{c.c.toFixed(2)}</b></span>
            {c.v != null && <span>V <b>{c.v.toLocaleString()}</b></span>}
            {c.t && <span style={{ color: '#8892a8' }}>{formatTimestamp(c.t, timeframe)}</span>}
            {tappedCandle && (
              <button type="button" onClick={() => { setTappedCandle(null); setMousePos(null); }}
                style={{ marginLeft: 'auto', flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', color: '#8892a8', fontSize: 12, padding: '0 2px', lineHeight: 1 }}>✕</button>
            )}
          </div>
        ) : null;
      })()}

      {canRender && (
      <>

      {/* Drawing mode touch hint */}
      {drawingMode && touchDrawPos && (
        <div style={{
          padding: '3px 8px', marginBottom: 4, borderRadius: 6,
          background: '#f5f3ff', border: '1px solid #c4b5fd',
          fontSize: 11, fontFamily: mono, color: '#8b5cf6', textAlign: 'center',
        }}>
          Price: {priceFor(touchDrawPos.y).toFixed(2)} · Lift finger to confirm
        </div>
      )}
      </>
      )}

      <div
        ref={wrapRef}
        style={{
          position: 'relative',
          overflow: 'hidden',
          borderRadius: 10,
          border: '1px solid #e2e5eb',
          background: '#fff',
          cursor: draggingHLine !== null ? 'ns-resize' : drawingMode ? 'crosshair' : 'default',
          touchAction: 'none',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none',
        }}
        role="img"
        aria-label={`Candlestick chart, ${slice.length} bars`}
      >
        {canRender ? <svg
          ref={svgRef}
          width={w}
          height={totalH}
          style={{ display: 'block' }}
          onClick={handleSvgClick}
          onMouseMove={handleSvgMouseMove}
          onMouseUp={handleSvgMouseUp}
          onMouseLeave={handleSvgMouseLeave}
          onTouchStart={handleSvgTouchStart}
          onTouchMove={handleSvgTouchMove}
          onTouchEnd={handleSvgTouchEnd}
        >
          {/* Grid + price labels on right */}
          {gridYs.map((gy, i) => (
            <g key={i}>
              <line x1={leftPad} y1={yFor(gy)} x2={chartRight} y2={yFor(gy)} stroke="#eef0f4" strokeWidth={1} />
              <text x={chartRight + 6} y={yFor(gy) + 4} fontSize={10} fill="#8892a8" fontFamily={mono}>{gy.toFixed(2)}</text>
            </g>
          ))}

          {/* Pattern highlight backgrounds + labels */}
          {highlightSignals && Array.from(highlightSet).map((i) => {
            const x = xFor(i);
            const hlGap = w < 500 ? 1 : 2;
            const bw = Math.max(w < 500 ? 3 : 1.5, chartW / slice.length - hlGap);
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
                  const clampedLabelX = Math.max(leftPad, Math.min(rawLabelX, chartRight - labelW - 2));
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
              <line x1={leftPad} y1={yFor(box.high)} x2={chartRight} y2={yFor(box.high)} stroke="#2563eb" strokeWidth={1} strokeDasharray="6 4" opacity={0.3} />
              <text x={leftPad + 4} y={yFor(box.high) - 3} fontSize={9} fill="#2563eb" fontFamily={mono} opacity={0.5}>LiqBox Hi</text>
              <line x1={leftPad} y1={yFor(box.low)} x2={chartRight} y2={yFor(box.low)} stroke="#2563eb" strokeWidth={1} strokeDasharray="6 4" opacity={0.3} />
              <text x={leftPad + 4} y={yFor(box.low) - 3} fontSize={9} fill="#2563eb" fontFamily={mono} opacity={0.5}>LiqBox Lo</text>
            </g>
          )}

          {/* Entry / SL / Target lines */}
          {risk && (risk.action === 'STRONG BUY' || risk.action === 'BUY' || risk.action === 'STRONG SHORT' || risk.action === 'SHORT') && (
            <g>
              {/* Entry — blue dashed */}
              <line x1={leftPad} y1={yFor(risk.entry)} x2={chartRight} y2={yFor(risk.entry)} stroke="#2563eb" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
              <rect x={leftPad + 2} y={yFor(risk.entry) - 12} width={62} height={14} rx={3} fill="#2563eb" opacity={0.85} />
              <text x={leftPad + 5} y={yFor(risk.entry) - 2} fontSize={8} fill="#fff" fontFamily={mono} fontWeight={700}>E {risk.entry.toFixed(1)}</text>
              {/* SL — red dashed */}
              <line x1={leftPad} y1={yFor(risk.sl)} x2={chartRight} y2={yFor(risk.sl)} stroke="#dc2626" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.7} />
              <rect x={leftPad + 2} y={yFor(risk.sl) - 12} width={62} height={14} rx={3} fill="#dc2626" opacity={0.85} />
              <text x={leftPad + 5} y={yFor(risk.sl) - 2} fontSize={8} fill="#fff" fontFamily={mono} fontWeight={700}>SL {risk.sl.toFixed(1)}</text>
              {/* Target — green dashed */}
              <line x1={leftPad} y1={yFor(risk.target)} x2={chartRight} y2={yFor(risk.target)} stroke="#16a34a" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.7} />
              <rect x={leftPad + 2} y={yFor(risk.target) - 12} width={62} height={14} rx={3} fill="#16a34a" opacity={0.85} />
              <text x={leftPad + 5} y={yFor(risk.target) - 2} fontSize={8} fill="#fff" fontFamily={mono} fontWeight={700}>T {risk.target.toFixed(1)}</text>
            </g>
          )}

          {/* Candles */}
          {slice.map((c, i) => {
            const x = xFor(i);
            const gap = w < 500 ? 1 : 2;
            const bw = Math.max(w < 500 ? 3 : 1.5, chartW / slice.length - gap);
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
            const wickW = Math.max(1, bw * 0.15);
            return (
              <g key={i}>
                <line x1={x} y1={yH} x2={x} y2={yL} stroke={fill} strokeWidth={wickW} />
                <rect
                  x={cx} y={top} width={bw} height={Math.max(1, bot - top)}
                  fill={fill}
                  stroke={highlighted ? '#2563eb' : fill}
                  strokeWidth={highlighted ? 1.5 : 0}
                  rx={1}
                />
                {last && (
                  <circle cx={x} cy={top - 4} r={2} fill={fill} opacity={0.5} />
                )}
              </g>
            );
          })}

          {/* Current price line — rendered early for line, label rendered later on top */}

          {/* User drawings */}
          {drawings.map((d, di) => {
            if (d.type === 'hline') {
              const y = yFor(d.price);
              const isDragging = draggingHLine === di;
              return (
                <g key={`d-${di}`}>
                  <line x1={leftPad} y1={y} x2={chartRight} y2={y} stroke="#8b5cf6" strokeWidth={1.5} strokeDasharray="6 3" />
                  {/* Price label on right */}
                  <rect x={chartRight + 2} y={y - 8} width={rightGutter - 6} height={16} rx={3} fill="#8b5cf6" opacity={0.85} />
                  <text x={chartRight + rightGutter / 2} y={y + 4} textAnchor="middle" fontSize={9} fill="#fff" fontFamily={mono} fontWeight={600}>{d.price.toFixed(2)}</text>
                  {/* Drag handle */}
                  <rect
                    x={leftPad + 4}
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
                  <text x={leftPad + 9} y={y + 4} fontSize={8} fill="#8b5cf6" fontFamily={mono} style={{ pointerEvents: 'none' }}>
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
          {mousePos && mousePos.y > 0 && mousePos.y < h && mousePos.x >= leftPad && (
            <g>
              {/* Horizontal crosshair */}
              <line x1={leftPad} y1={mousePos.y} x2={chartRight} y2={mousePos.y}
                stroke={drawingMode ? '#8b5cf6' : '#8892a8'} strokeWidth={0.5} strokeDasharray="2 2" opacity={0.5} />
              {/* Vertical crosshair */}
              {(() => {
                const ci = Math.max(0, Math.min(slice.length - 1, idxFor(mousePos.x)));
                return (
                  <line x1={xFor(ci)} y1={4} x2={xFor(ci)} y2={h}
                    stroke={drawingMode ? '#8b5cf6' : '#8892a8'} strokeWidth={0.5} strokeDasharray="2 2" opacity={0.4} />
                );
              })()}
              {/* Price label on right axis */}
              {(() => {
                const priceText = priceFor(mousePos.y).toFixed(2);
                const pillW = rightGutter - 6;
                const pillX = chartRight + 2;
                const pillColor = drawingMode ? '#8b5cf6' : '#4a5068';
                return (
                  <g>
                    <rect x={pillX} y={mousePos.y - 8} width={pillW} height={16} rx={3}
                      fill={pillColor} opacity={0.9} />
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

          {/* Current price line + label on right axis */}
          {(() => {
            const last = slice[slice.length - 1];
            const y = yFor(last.c);
            return (
              <g>
                <line x1={leftPad} y1={y} x2={chartRight} y2={y} stroke="#2563eb" strokeWidth={1} strokeDasharray="4 3" opacity={0.5} />
                <rect x={chartRight + 2} y={y - 8} width={rightGutter - 6} height={16} rx={3} fill="#2563eb" />
                <text x={chartRight + rightGutter / 2} y={y + 4} textAnchor="middle" fontSize={10} fill="#fff" fontFamily={mono} fontWeight={600}>
                  {last.c.toFixed(2)}
                </text>
              </g>
            );
          })()}

          {/* X-axis timestamps */}
          {xLabels.map(({ idx, text, isDateChange }) => (
            <g key={`xl-${idx}`}>
              {/* Tick mark */}
              <line x1={xFor(idx)} y1={h} x2={xFor(idx)} y2={h + 4} stroke={isDateChange ? '#2563eb' : '#c8ccd4'} strokeWidth={1} />
              <text
                x={xFor(idx)}
                y={h + 15}
                textAnchor="middle"
                fontSize={9}
                fontWeight={isDateChange ? 700 : 400}
                fill={isDateChange ? '#2563eb' : '#8892a8'}
                fontFamily={mono}
              >
                {text}
              </text>
            </g>
          ))}
          {/* Long-press crosshair overlay */}
          {crosshair && (
            <g>
              <line x1={leftPad} y1={crosshair.y} x2={chartRight} y2={crosshair.y}
                stroke="#2563eb" strokeWidth={1} strokeDasharray="4,3" opacity={0.7} />
              <line x1={crosshair.x} y1={4} x2={crosshair.x} y2={h - 4}
                stroke="#2563eb" strokeWidth={1} strokeDasharray="4,3" opacity={0.7} />
              <rect x={chartRight + 2} y={crosshair.y - 10} width={55} height={20} rx={4}
                fill="#2563eb" />
              <text x={chartRight + 6} y={crosshair.y + 4} fontSize={10} fill="#fff" fontFamily={mono}>
                {priceFor(crosshair.y).toFixed(2)}
              </text>
            </g>
          )}
        </svg>
        : <div style={{ minHeight: height + X_AXIS_HEIGHT }} />}
        {/* Floating "+" button for adding hline at crosshair price */}
        {canRender && crosshair && onDrawingComplete && (
          <button
            type="button"
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              const price = priceFor(crosshair.y);
              onDrawingComplete({ type: 'hline', price });
              setCrosshair(null);
              longPressActive.current = false;
            }}
            onTouchStart={(e) => e.stopPropagation()}
            onTouchEnd={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              left: Math.min(crosshair.x + 12, containerWidth - 40),
              top: crosshair.y - 14,
              width: 36, height: 36, borderRadius: 18,
              background: '#2563eb', color: '#fff',
              border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 20, fontWeight: 700, lineHeight: 1,
              boxShadow: '0 2px 8px rgba(37,99,235,0.4)',
              zIndex: 10,
            }}
            aria-label="Add horizontal line at this price"
          >+</button>
        )}
      </div>
    </div>
  );
})
