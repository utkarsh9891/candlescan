import { useEffect, useState } from 'react';
import { fetchOHLCV } from '../engine/fetcher.js';
import { getMarketStatus } from '../utils/marketHours.js';

/**
 * Compact live-price strip for NSE indices.
 *
 * Renders a single-line horizontal ticker (symbol · last · change · %)
 * sourced from Yahoo Finance daily candles via the existing fetcher
 * pipeline. In off-market hours Yahoo returns the last trading day's
 * close, so the strip stays populated around the clock.
 *
 * Refresh cadence:
 *   - During market hours: re-polls every 60 s.
 *   - Off-market: single fetch on mount (close won't change until 09:15).
 *   - Pauses while the tab is hidden, re-fires immediately on focus.
 *
 * Props:
 *   symbol  — TradingView-style code ("NSE:NIFTY", "NSE:BANKNIFTY", …).
 *             Mapped internally to a Yahoo symbol.
 *   height  — px height of the container. Default 28.
 */

const LIVE_REFRESH_MS = 60 * 1000;

const TV_TO_YAHOO = {
  'NSE:NIFTY': { yahoo: '^NSEI', label: 'NIFTY 50' },
  'NSE:BANKNIFTY': { yahoo: '^NSEBANK', label: 'BANK NIFTY' },
  'NSE:CNXIT': { yahoo: '^CNXIT', label: 'NIFTY IT' },
  'NSE:CNXMIDCAP': { yahoo: '^CNXMDCP', label: 'NIFTY MIDCAP 100' },
  'NSE:CNXSMALLCAP': { yahoo: '^CNXSC', label: 'NIFTY SMALLCAP 100' },
  'NSE:INDIAVIX': { yahoo: '^INDIAVIX', label: 'INDIA VIX' },
};

function resolve(symbol) {
  return TV_TO_YAHOO[symbol] || { yahoo: '^NSEI', label: symbol.split(':').pop() || symbol };
}

function fmtPrice(n) {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtChange(n, { signed = false } = {}) {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n).toFixed(2);
  const sign = signed ? (n >= 0 ? '+' : '−') : '';
  return `${sign}${abs}`;
}

export default function SingleTickerWidget({ symbol = 'NSE:NIFTY', height = 28 }) {
  const { yahoo, label } = resolve(symbol);
  const [state, setState] = useState({ status: 'loading', last: null, change: null, pct: null });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', last: null, change: null, pct: null });

    const runFetch = async () => {
      try {
        const res = await fetchOHLCV(yahoo, '1d');
        if (cancelled) return;
        const candles = res?.candles || [];
        if (!candles.length) {
          setState({ status: 'failed', last: null, change: null, pct: null });
          return;
        }
        const last = candles[candles.length - 1];
        const prev = candles.length >= 2 ? candles[candles.length - 2] : null;
        const change = prev ? last.c - prev.c : 0;
        const pct = prev && prev.c ? (change / prev.c) * 100 : 0;
        setState({ status: 'ok', last: last.c, change, pct });
      } catch {
        if (!cancelled) setState({ status: 'failed', last: null, change: null, pct: null });
      }
    };

    runFetch();

    let timer = null;
    const startPolling = () => {
      if (timer) return;
      if (document.visibilityState !== 'visible') return;
      if (!getMarketStatus().isOpen) return;
      timer = setInterval(runFetch, LIVE_REFRESH_MS);
    };
    const stopPolling = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };
    startPolling();

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        runFetch();
        startPolling();
      } else {
        stopPolling();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [yahoo]);

  const up = state.status === 'ok' && (state.change ?? 0) >= 0;
  const color = state.status !== 'ok' ? '#8892a8' : up ? '#16a34a' : '#dc2626';

  const containerStyle = {
    height,
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    fontWeight: 600,
    color: '#1a1d26',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
  };

  if (state.status === 'loading') {
    return (
      <div
        role="region"
        aria-label={`Live price ticker: ${symbol}`}
        data-testid="single-ticker-widget"
        data-symbol={symbol}
        style={{ ...containerStyle, color: '#8892a8', fontWeight: 500 }}
      >
        <span>{label}</span>
        <span style={{ fontSize: 11 }}>loading…</span>
      </div>
    );
  }

  if (state.status === 'failed') {
    return (
      <div
        role="status"
        aria-label="Market ticker unavailable"
        data-testid="single-ticker-fallback"
        style={{ ...containerStyle, color: '#8892a8', fontWeight: 500, fontSize: 11 }}
      >
        {label} · data unavailable
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label={`Live price ticker: ${symbol}`}
      data-testid="single-ticker-widget"
      data-symbol={symbol}
      style={containerStyle}
    >
      <span style={{ color: '#4a5068', letterSpacing: 0.3 }}>{label}</span>
      <span style={{ fontFamily: "'SF Mono', Menlo, monospace" }}>{fmtPrice(state.last)}</span>
      <span style={{ color, fontFamily: "'SF Mono', Menlo, monospace" }}>
        {fmtChange(state.change, { signed: true })}
      </span>
      <span style={{ color, fontSize: 11 }}>
        ({up ? '+' : '−'}{Math.abs(state.pct ?? 0).toFixed(2)}%)
      </span>
    </div>
  );
}
