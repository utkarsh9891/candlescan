# CandleScan

React + Vite mini-app: NSE-oriented candlestick pattern hints, liquidity-box readout, and a **0–100 risk score**. Mobile-first, light UI.

**Educational only — not financial advice.**

Live (when deployed): `https://utkarsh9891.github.io/candlescan/`  
Source: this repository.

---

## Tech stack

- **React 18** — UI
- **Vite 6** — dev server, production build, `/__candlescan-yahoo` dev proxy
- **Yahoo Finance** chart API (v8) — OHLCV (via proxy on localhost dev, CORS proxies on HTTPS deploy)

---

## Prerequisites

- **Node.js** LTS ([nodejs.org](https://nodejs.org))
- **npm** (bundled with Node)

---

## Quick start

```bash
git clone https://github.com/utkarsh9891/candlescan.git
cd candlescan
npm install
npm start
```

Open **http://127.0.0.1:5173/candlescan/** (printed in the terminal).

---

## npm scripts

| Script | Description |
|--------|-------------|
| `npm start` / `npm run dev` | Vite dev server (fixed host/port in `vite.config.js`) |
| `npm run build` | Production bundle → `dist/` (`base: /candlescan/`) |
| `npm run preview` | Serve `dist/` locally (no dev proxy; uses CORS fallbacks like GitHub Pages) |
| `npm run pages` | Build + copy `dist/` into sibling **`../utkarsh9891.github.io/candlescan/`** (or pass path — see `scripts/deploy-to-pages.sh`) |
| `npm run test:batch` | Run engine over an NSE index (uses **`cache/charts`** by default; see below) |
| `npm run cache:charts` | Warm **`cache/charts`** from Yahoo for all symbols in an index |

### Local Yahoo chart cache (`cache/charts/`)

- **Gitignored** JSON snapshots per symbol + timeframe (`cache/charts/README.md`).
- **`npm start`**: Vite serves chart requests from disk when the file is fresh; otherwise fetches Yahoo and saves. Header `X-CandleScan-Chart-Cache: hit|miss` for debugging.
- **Disable**: `CANDLESCAN_CHART_CACHE=0 npm start`
- **Staleness**: `CANDLESCAN_CHART_CACHE_MAX_AGE_MS` (default 7 days; set `0` for “use until deleted”).
- **Batch**: `node scripts/batch-test.mjs` reads/writes the same folder; `--no-chart-cache` / `--refresh-charts` to override.

---

## Project layout

```text
candlescan/
├── index.html              # Vite entry
├── vite.config.js          # base, dev proxy, server host/port
├── package.json
├── scripts/
│   ├── start.sh            # npm start wrapper (prints URL)
│   └── deploy-to-pages.sh  # npm run pages
└── src/
    ├── main.jsx
    ├── App.jsx
    ├── components/         # UI pieces
    └── engine/             # fetcher, patterns, liquidity, risk
```

---

## Local development

### Normal dev (live Yahoo via Vite)

```bash
npm install
npm start
```

Vite proxies **`/__candlescan-yahoo`** → `query1.finance.yahoo.com` so the browser stays same-origin.

### Demo OHLCV without Yahoo (dev only)

Add **`?simulate=1`** (or `simulate=true`) to the dev URL:

`http://127.0.0.1:5173/candlescan/?simulate=1`

Only active when **`import.meta.env.DEV`** is true — **not** on the production build.

### Production build locally

```bash
npm run build
npm run preview
```

### Full site + CandleScan (matches Pages layout)

Use the **[utkarsh9891.github.io](https://github.com/utkarsh9891/utkarsh9891.github.io)** repo:

```bash
cd ../utkarsh9891.github.io   # sibling clone
npm start
```

That server also implements **`/__candlescan-yahoo`** so the **built** app under **`/candlescan/`** gets live data on **http://127.0.0.1:8080/**.

---

## Data loading by environment

| Environment | How Yahoo is reached |
|-------------|----------------------|
| **`npm start` here** | Vite dev proxy `/__candlescan-yahoo` |
| **Pages repo `npm start`** | Node `local-dev-server.mjs` — same path |
| **GitHub Pages (HTTPS)** | Public CORS proxies (`allorigins`, `corsproxy`, …) after direct fetch |

If every path fails on HTTPS, the UI shows an error (no silent simulated data except **`?simulate=1`** in dev).

### NSE index constituents (“Browse stocks”)

Lists are loaded at runtime from NSE **`/api/equity-stockIndices`** (index names in `src/config/nseIndices.js`).

| Environment | How NSE is reached |
|-------------|-------------------|
| **`npm start`** | Vite proxy `/candlescan/__candlescan-nse` → `www.nseindia.com` |
| **GitHub Pages** | Cloudflare Worker must allow **`https://www.nseindia.com/api/*`** (see `worker/index.js`) — **redeploy worker** after updating |

---

## Deploy to GitHub Pages

Deployment is automated via **GitHub Actions** (`.github/workflows/deploy.yml`).

**On every push to `main`:**
1. GitHub Actions builds the app (`npm ci && npm run build`)
2. Deploys `dist/` to GitHub Pages
3. Live at **`https://utkarsh9891.github.io/candlescan/`**

**Setup (one-time):** Go to repo Settings → Pages → Source: **"GitHub Actions"**

### Manual deploy (legacy)

```bash
npm run pages   # Build + copy to ../utkarsh9891.github.io/candlescan/
```

---

## Debugging & troubleshooting

| Issue | What to try |
|-------|-------------|
| **`npm start` says run `npm install`** | Run `npm install` once in this repo. |
| **Blank or wrong base path** | `vite.config.js` sets `base: '/candlescan/'` for Pages; dev URL must include `/candlescan/`. |
| **No chart data on GitHub Pages** | Networks/ad blockers may block CORS proxies; try another network or device. |
| **No data in `npm run preview`** | Expected — no dev proxy; use **`npm start`** or the Pages repo **`npm start`**. |
| **Browse stocks empty / NSE error on Pages** | Redeploy Cloudflare Worker with NSE allowlist; or network blocked NSE/allorigins. |
| **Verbose Vite logs** | `DEBUG=vite:* npm start` (shell-dependent). |
| **Inspect built bundle** | After `npm run build`, check `dist/assets/*.js`. |

### Health checks

```bash
# Dev server up — from repo root
curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/candlescan/

# After build
test -f dist/index.html && echo "build ok"
```

---

## License

See [LICENSE](LICENSE) in this repository.

