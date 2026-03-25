# CandleScan

Intraday decision-support for NSE stocks: candlestick pattern detection, liquidity-box analysis, and a **0–100 risk score**. Mobile-first, light-mode UI. Not a trading bot — a signal scanner with risk scoring.

**Status:** in progress.

## Run locally

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173/candlescan/`).

## Preview a production build

```bash
npm run build
npm run preview
```

## Deploy to GitHub Pages

The app is served from **`https://utkarsh9891.github.io/candlescan/`**. The built assets need to land in the **`candlescan/`** folder of the **[utkarsh9891.github.io](https://github.com/utkarsh9891/utkarsh9891.github.io)** repo.

### One-command deploy script

```bash
chmod +x scripts/deploy-to-pages.sh
./scripts/deploy-to-pages.sh /path/to/utkarsh9891.github.io
```

This runs `npm ci`, `npm run build`, and copies `dist/` into the target repo's `candlescan/` folder. You then commit and push **`utkarsh9891.github.io`** to publish.

### Manual steps

```bash
npm run build
rm -rf /path/to/utkarsh9891.github.io/candlescan/*
cp -R dist/. /path/to/utkarsh9891.github.io/candlescan/
cd /path/to/utkarsh9891.github.io
git add candlescan && git commit -m "Deploy CandleScan" && git push
```

## Data source

Uses Yahoo Finance v8 chart API. If CORS blocks the request (common in dev), the app falls back to **simulated OHLCV** and shows a SIMULATED badge.

## Disclaimer

Educational tool only — not financial advice. You are responsible for your trades.
