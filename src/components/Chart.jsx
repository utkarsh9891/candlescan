/**
 * Chart — TradingView Lightweight Charts wrapper.
 *
 * Replaces the custom 1100-line SVG candlestick renderer with the
 * battle-tested TradingView Lightweight Charts library (Apache 2.0,
 * ~45KB gzipped). All touch/wheel/zoom/pan/crosshair handling is
 * delegated to the library — zero custom gesture code.
 *
 * TV native features used:
 *   - CandlestickSeries (OHLC rendering)
 *   - HistogramSeries (volume overlay)
 *   - Price lines (entry/SL/target, user hlines, liquidity box bounds)
 *   - Series markers (pattern signal annotations)
 *   - Crosshair + subscribeCrosshairMove (OHLCV info bar)
 *   - Pinch-to-zoom, scroll-wheel zoom, touch pan (all native)
 *   - subscribeVisibleLogicalRangeChange (lazy history prefetch)
 *   - subscribeClick (drawing tool placement)
 */

import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import {
  createChart, CrosshairMode, LineStyle,
  CandlestickSeries, HistogramSeries, createSeriesMarkers,
} from 'lightweight-charts';

const mono = "'SF Mono', Menlo, monospace";
const RISK_ACTIONS = new Set(['BUY', 'STRONG BUY', 'SHORT', 'STRONG SHORT']);

function formatTimestamp(ts, timeframe) {
  const d = new Date(ts * 1000);
  if (timeframe === '1d') {
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Deduplicate and sort candle data for TV (requires strictly ascending integer timestamps). */
function prepareData(candles) {
  const seen = new Set();
  const ohlc = [];
  const vol = [];
  for (let i = candles.length - 1; i >= 0; i--) {
    const t = Math.round(candles[i].t);
    if (seen.has(t)) continue;
    seen.add(t);
    ohlc.push({ time: t, open: candles[i].o, high: candles[i].h, low: candles[i].l, close: candles[i].c });
    vol.push({ time: t, value: candles[i].v || 0, color: candles[i].c >= candles[i].o ? 'rgba(22,163,74,0.2)' : 'rgba(220,38,38,0.2)' });
  }
  ohlc.reverse();
  vol.reverse();
  return { ohlc, vol };
}

/* ── OHLCV info bar ──────────────────────────────────────────────── */

function OhlcvBar({ data, lastCandle, timeframe }) {
  const c = data || (lastCandle
    ? { open: lastCandle.o, high: lastCandle.h, low: lastCandle.l, close: lastCandle.c, volume: lastCandle.v, time: lastCandle.t }
    : null);
  if (!c) return null;
  const bull = c.close >= c.open;
  return (
    <div style={{
      display: 'flex', gap: 5, alignItems: 'center',
      padding: '3px 6px', marginBottom: 4, borderRadius: 6,
      background: data ? '#f0f4ff' : '#f8f9fb',
      border: `1px solid ${data ? '#dbeafe' : '#e2e5eb'}`,
      fontSize: 10, fontFamily: mono, color: '#4a5068',
      whiteSpace: 'nowrap', overflow: 'hidden',
    }}>
      <span>O <b>{c.open?.toFixed(2)}</b></span>
      <span>H <b>{c.high?.toFixed(2)}</b></span>
      <span>L <b>{c.low?.toFixed(2)}</b></span>
      <span>C <b style={{ color: bull ? '#16a34a' : '#dc2626' }}>{c.close?.toFixed(2)}</b></span>
      {c.volume != null && <span>V <b>{Math.round(c.volume).toLocaleString()}</b></span>}
      {c.time && <span style={{ color: '#8892a8' }}>{formatTimestamp(c.time, timeframe)}</span>}
    </div>
  );
}

/* ── Main Chart component ────────────────────────────────────────── */

export default forwardRef(function Chart({
  candles,
  box,
  risk,
  height = 260,
  sym = '',
  timeframe = '5m',
  drawingMode = null,
  drawings = [],
  onDrawingComplete,
  patterns = [],
  highlightSignals = false,
  onNearLeftEdge,
  loadingMore = false,
}, ref) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const riskLinesRef = useRef([]);
  const drawingLinesRef = useRef([]);
  const boxLinesRef = useRef([]);
  const markersPluginRef = useRef(null);
  const prevSymKeyRef = useRef('');
  const nearEdgeFiredRef = useRef('');
  const lastOhlcvTimeRef = useRef(null);
  const drawingModeRef = useRef(null);
  const onDrawingCompleteRef = useRef(null);
  const pendingBoxRef = useRef(null);
  const chartIdRef = useRef(0);
  const roRef = useRef(null);
  const [ohlcvData, setOhlcvData] = useState(null);
  const [pendingBoxHint, setPendingBoxHint] = useState(false);

  drawingModeRef.current = drawingMode;
  onDrawingCompleteRef.current = onDrawingComplete;

  useEffect(() => {
    pendingBoxRef.current = null;
    setPendingBoxHint(false);
  }, [drawingMode]);

  /* ── Effect 1: Chart creation (mount only) ────────────────────── */
  // Creates the chart + series once on mount, destroys on unmount.
  // Never re-runs for data/timeframe changes — those are handled by
  // the data effect below.
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const id = ++chartIdRef.current;

    const chart = createChart(container, {
      width: container.clientWidth || 400,
      height,
      layout: {
        background: { color: '#ffffff' },
        textColor: '#8892a8',
        fontFamily: mono,
        fontSize: 10,
      },
      grid: {
        vertLines: { color: '#eef0f4' },
        horzLines: { color: '#eef0f4' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#e2e5eb' },
      timeScale: {
        borderColor: '#e2e5eb',
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinchZoom: true,
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#16a34a',
      downColor: '#dc2626',
      borderUpColor: '#16a34a',
      borderDownColor: '#dc2626',
      wickUpColor: '#16a34a',
      wickDownColor: '#dc2626',
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    // Crosshair → OHLCV bar
    chart.subscribeCrosshairMove((param) => {
      if (chartIdRef.current !== id) return;
      if (!param.time) {
        if (lastOhlcvTimeRef.current !== null) {
          lastOhlcvTimeRef.current = null;
          setOhlcvData(null);
        }
        return;
      }
      if (param.time === lastOhlcvTimeRef.current) return;
      lastOhlcvTimeRef.current = param.time;
      const cd = param.seriesData.get(candleSeries);
      const vd = param.seriesData.get(volumeSeries);
      if (cd) {
        setOhlcvData({
          open: cd.open, high: cd.high, low: cd.low, close: cd.close,
          volume: vd?.value, time: param.time,
        });
      }
    });

    // Click → drawing placement
    chart.subscribeClick((param) => {
      if (chartIdRef.current !== id) return;
      const mode = drawingModeRef.current;
      const cb = onDrawingCompleteRef.current;
      if (!mode || !cb || !param.point) return;

      const price = candleSeries.coordinateToPrice(param.point.y);
      if (price === null || !isFinite(price)) return;

      if (mode === 'hline') {
        cb({ type: 'hline', price });
        return;
      }
      if (mode === 'box') {
        const time = param.time;
        if (!pendingBoxRef.current) {
          pendingBoxRef.current = { price, time };
          setPendingBoxHint(true);
        } else {
          const p1 = pendingBoxRef.current;
          const pTop = Math.max(p1.price, price);
          const pBot = Math.min(p1.price, price);
          cb({
            type: 'box', priceTop: pTop, priceBot: pBot,
            time1: p1.time, time2: time,
            startPrice: p1.price, endPrice: price,
            priceChange: price - p1.price,
          });
          pendingBoxRef.current = null;
          setPendingBoxHint(false);
        }
      }
    });

    // Resize observer
    const ro = new ResizeObserver((entries) => {
      if (chartIdRef.current !== id) return;
      const { width } = entries[0].contentRect;
      if (width > 0) chart.applyOptions({ width });
    });
    ro.observe(container);
    roRef.current = ro;

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    return () => {
      roRef.current?.disconnect();
      roRef.current = null;
      try { chart.remove(); } catch { /* already removed */ }
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      prevSymKeyRef.current = '';
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Effect 2: Set data on existing chart ─────────────────────── */
  // Runs whenever candles/sym/timeframe change. Reads refs set by
  // the creation effect. If the chart isn't ready yet (shouldn't
  // happen, but defensive), skips silently.
  useEffect(() => {
    const series = candleSeriesRef.current;
    const volSeries = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (!series || !volSeries || !chart || !candles?.length) return;

    const lastTs = candles[candles.length - 1]?.t || 0;
    const key = `${sym}:${timeframe}:${Math.round(lastTs)}:${candles.length}`;
    if (key === prevSymKeyRef.current) return;

    const prev = prevSymKeyRef.current.split(':');
    const isSameSeries = prev[0] === sym && prev[1] === timeframe && Number(prev[2]) === Math.round(lastTs);
    const isPrepend = isSameSeries && candles.length > Number(prev[3] || 0);
    prevSymKeyRef.current = key;

    const savedRange = isPrepend ? chart.timeScale().getVisibleRange() : null;
    const { ohlc, vol } = prepareData(candles);

    try {
      series.setData(ohlc);
      volSeries.setData(vol);
    } catch (e) {
      console.warn('[Chart] setData error:', e.message);
      return;
    }

    if (isPrepend && savedRange) {
      chart.timeScale().setVisibleRange(savedRange);
    } else {
      chart.timeScale().fitContent();
    }

    // Reset crosshair data for new series
    setOhlcvData(null);
    lastOhlcvTimeRef.current = null;
  }, [candles, sym, timeframe]);

  /* ── Risk overlay: entry / SL / target price lines ─────────────── */
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    for (const line of riskLinesRef.current) {
      try { series.removePriceLine(line); } catch { /* ok */ }
    }
    riskLinesRef.current = [];

    if (!risk || !highlightSignals || !RISK_ACTIONS.has(risk.action)) return;

    const lines = [
      { price: risk.entry, color: '#2563eb', title: `E ${risk.entry.toFixed(1)}`, width: 1 },
      { price: risk.sl, color: '#dc2626', title: `SL ${risk.sl.toFixed(1)}`, width: 2 },
      { price: risk.target, color: '#16a34a', title: `T ${risk.target.toFixed(1)}`, width: 2 },
    ];

    for (const l of lines) {
      riskLinesRef.current.push(series.createPriceLine({
        price: l.price, color: l.color, lineWidth: l.width,
        lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: l.title,
      }));
    }
  }, [risk, highlightSignals]);

  /* ── Pattern signal markers ────────────────────────────────────── */
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || !candles?.length) return;

    if (markersPluginRef.current) {
      try { markersPluginRef.current.detach(); } catch { /* ok */ }
      markersPluginRef.current = null;
    }

    if (!highlightSignals || !patterns?.length) return;

    const markers = [];
    for (const p of patterns) {
      if (!p.candleIndices?.length) continue;
      const lastIdx = p.candleIndices[p.candleIndices.length - 1];
      if (lastIdx < 0 || lastIdx >= candles.length) continue;
      const candle = candles[lastIdx];
      if (!candle?.t) continue;
      const isBullish = p.direction === 'bullish';
      markers.push({
        time: Math.round(candle.t),
        position: isBullish ? 'belowBar' : 'aboveBar',
        color: isBullish ? '#16a34a' : p.direction === 'bearish' ? '#dc2626' : '#2563eb',
        shape: isBullish ? 'arrowUp' : 'arrowDown',
        text: `${p.emoji || ''} ${p.name}`.trim(),
      });
    }

    if (markers.length > 0) {
      markers.sort((a, b) => a.time - b.time);
      markersPluginRef.current = createSeriesMarkers(series, markers);
    }
  }, [patterns, highlightSignals, candles]);

  /* ── User drawing price lines ──────────────────────────────────── */
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    for (const line of drawingLinesRef.current) {
      try { series.removePriceLine(line); } catch { /* ok */ }
    }
    drawingLinesRef.current = [];

    for (const d of drawings) {
      if (d.type === 'hline') {
        drawingLinesRef.current.push(series.createPriceLine({
          price: d.price, color: '#8b5cf6', lineWidth: 1,
          lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: d.price.toFixed(2),
        }));
      } else if (d.type === 'box') {
        const change = d.priceChange != null ? d.priceChange : d.priceTop - d.priceBot;
        const basePrice = d.startPrice || d.priceBot;
        const changePct = ((change / basePrice) * 100).toFixed(1);
        const sign = change >= 0 ? '+' : '';
        const color = change >= 0 ? '#16a34a' : '#dc2626';
        drawingLinesRef.current.push(series.createPriceLine({
          price: d.priceTop, color, lineWidth: 1,
          lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `${sign}${changePct}%`,
        }));
        drawingLinesRef.current.push(series.createPriceLine({
          price: d.priceBot, color, lineWidth: 1,
          lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: d.priceBot.toFixed(1),
        }));
      }
    }
  }, [drawings]);

  /* ── Liquidity box price lines ─────────────────────────────────── */
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    for (const line of boxLinesRef.current) {
      try { series.removePriceLine(line); } catch { /* ok */ }
    }
    boxLinesRef.current = [];

    if (!box || !highlightSignals) return;

    boxLinesRef.current.push(series.createPriceLine({
      price: box.high, color: '#2563eb', lineWidth: 1,
      lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Box Hi',
    }));
    boxLinesRef.current.push(series.createPriceLine({
      price: box.low, color: '#2563eb', lineWidth: 1,
      lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Box Lo',
    }));
  }, [box, highlightSignals]);

  /* ── Lazy history prefetch ─────────────────────────────────────── */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !onNearLeftEdge) return;

    const handler = (range) => {
      if (loadingMore || !candles?.length) return;
      if (range !== null && range.from < candles.length * 0.2) {
        const total = candles.length;
        const seriesKey = `${sym}:${timeframe}:${Math.round(candles[total - 1]?.t)}:${total}`;
        if (nearEdgeFiredRef.current === seriesKey) return;
        nearEdgeFiredRef.current = seriesKey;
        onNearLeftEdge();
      }
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    return () => {
      try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler); } catch { /* ok */ }
    };
  }, [onNearLeftEdge, loadingMore, candles, sym, timeframe]);

  /* ── Height changes ────────────────────────────────────────────── */
  useEffect(() => {
    chartRef.current?.applyOptions({ height });
  }, [height]);

  /* ── Imperative API ────────────────────────────────────────────── */
  useImperativeHandle(ref, () => ({
    fitContent: () => chartRef.current?.timeScale().fitContent(),
  }), []);

  /* ── Render ────────────────────────────────────────────────────── */
  const lastCandle = candles?.length ? candles[candles.length - 1] : null;

  return (
    <div style={{ marginBottom: 12, userSelect: 'none', WebkitUserSelect: 'none' }}>
      <OhlcvBar data={ohlcvData} lastCandle={lastCandle} timeframe={timeframe} />

      {drawingMode && (
        <div style={{ fontSize: 11, color: '#8b5cf6', fontWeight: 500, marginBottom: 4 }}>
          {drawingMode === 'hline'
            ? 'Tap chart to place line'
            : pendingBoxHint ? 'Tap end point' : 'Tap start point'}
        </div>
      )}

      <div
        ref={containerRef}
        style={{
          borderRadius: 10,
          overflow: 'hidden',
          border: '1px solid #e2e5eb',
          cursor: drawingMode ? 'crosshair' : 'default',
        }}
      />
    </div>
  );
});
