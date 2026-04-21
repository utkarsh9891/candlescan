import { useEffect, useRef, useState } from 'react';

/**
 * TradingView Single Ticker Widget.
 *
 * Embeds the TradingView `embed-widget-single-quote.js` script inside a
 * container div. The widget itself is rendered by TradingView into an
 * iframe, so the page bundle stays untouched (no added JS in our build).
 *
 * Props:
 *   symbol  — TradingView symbol, e.g. "NSE:NIFTY", "NSE:BANKNIFTY". Default "NSE:NIFTY".
 *   height  — px height of the container. Default 40.
 *
 * If the external script fails to load (blocked, offline, SW interference),
 * a tiny inline fallback is rendered instead.
 */
export default function SingleTickerWidget({ symbol = 'NSE:NIFTY', height = 40 }) {
  const containerRef = useRef(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Reset any previous render (e.g. when symbol changes)
    setFailed(false);
    container.innerHTML = '';

    // TV widget expects a specific nested structure:
    //   .tradingview-widget-container
    //     .tradingview-widget-container__widget   <-- TV fills this
    //     <script src="...embed-widget-single-quote.js">{JSON config}</script>
    const widgetDiv = document.createElement('div');
    widgetDiv.className = 'tradingview-widget-container__widget';
    container.appendChild(widgetDiv);

    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.async = true;
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-single-quote.js';
    script.innerHTML = JSON.stringify({
      symbol,
      width: '100%',
      // TV widget has a fixed internal layout — it ignores `height` and
      // lays itself out at ~120px. We clip via the outer container's
      // `overflow:hidden` + fixed height so only the top price strip shows.
      colorTheme: 'light',
      isTransparent: true,
      locale: 'en',
    });

    let didFail = false;
    const onError = () => {
      if (didFail) return;
      didFail = true;
      setFailed(true);
    };
    script.addEventListener('error', onError);

    container.appendChild(script);

    return () => {
      script.removeEventListener('error', onError);
      // Remove the injected script and widget DOM on unmount or symbol change.
      if (container) container.innerHTML = '';
    };
  }, [symbol]);

  if (failed) {
    return (
      <div
        role="status"
        aria-label="Market ticker unavailable"
        data-testid="single-ticker-fallback"
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          color: '#8892a8',
          background: 'transparent',
        }}
      >
        Market data unavailable
      </div>
    );
  }

  // Wrapper owns the fixed height. The TV widget's own script mutates its
  // container's inline `style.height` after load (it auto-sizes to ~120px
  // for the single-quote layout), so we wrap it in a parent with fixed
  // dimensions + overflow:hidden — the widget still renders, but only the
  // top price strip is visible.
  return (
    <div
      role="region"
      aria-label={`Live price ticker: ${symbol}`}
      data-testid="single-ticker-widget"
      data-symbol={symbol}
      style={{
        height,
        width: '100%',
        border: 'none',
        overflow: 'hidden',
        background: 'transparent',
      }}
    >
      <div
        ref={containerRef}
        className="tradingview-widget-container"
        style={{ width: '100%' }}
      />
    </div>
  );
}
