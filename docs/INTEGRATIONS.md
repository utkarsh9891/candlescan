# External Integrations

Complete inventory of every external data source and API the app talks to. Each entry documents the source, what it provides, which parts of the app consume it, whether results are cached, how to turn it off, and known failure modes.

## Table of Contents

- [1. Yahoo Finance](#1-yahoo-finance)
- [2. Zerodha Kite Connect](#2-zerodha-kite-connect)
- [3. Dhan HQ](#3-dhan-hq)
- [4. NSE Public API](#4-nse-public-api)
- [5. GitHub Releases API](#5-github-releases-api)
- [6. Cloudflare Worker (in-house proxy)](#6-cloudflare-worker-in-house-proxy)
- [7. Market Context Signals (multi-factor)](#7-market-context-signals-multi-factor)
- [Summary Matrix](#summary-matrix)

---

## 1. Yahoo Finance

**Primary OHLCV data source. Free, no auth, no API key, ~1-2 min delayed.**

| Attribute | Value |
|---|---|
| **Base URL** | `https://query1.finance.yahoo.com` and `https://query2.finance.yahoo.com` |
| **Auth** | None |
| **Rate limit** | Unofficial ~100 req/hour from a single IP |
| **Client code** | `src/engine/fetcher.js`, `src/engine/yahooQuote.js`, `src/engine/indexDirection.js` |
| **Worker proxy** | `GET /?u=<yahoo-url>` generic passthrough (for CORS in production PWA) |
| **On/off control** | Always on as fallback; Settings → Data Source selects Yahoo explicitly |

### Endpoints consumed

- **`/v8/finance/chart/{symbol}?interval=X&range=Y`** — OHLCV candles. Used for: Single Stock Scanner, Batch Index Scanner, Simulation, Paper Trading. Returns 1m / 5m / 15m / 30m / 1h / 1d intervals.
- **`/v7/finance/quote?symbols=X`** — Bid/ask and last price for real-time price updates. Used by Paper Trading page for live P&L.

### Cached?

- **Yes, in dev**: `vite-plugin-chart-cache.mjs` writes all chart responses to `cache/charts/<SYMBOL>/<INTERVAL>/<DATE>.json`. Subsequent fetches serve from disk.
- **No, in production**: PWA does not cache chart data (always-fresh intraday quotes).
- **Dev cache can be disabled**: `CANDLESCAN_CHART_CACHE=0 npm start`

### Known issues

- Cross-origin requests from the PWA need the Worker proxy (`candlescan-proxy.utkarsh-dev.workers.dev`) because Yahoo blocks direct browser access.
- `quoteSummary` module endpoints (for company profile / sector / news) now require a crumb + cookie — **not usable** in current form without a full scraping workflow.
- Per-symbol news endpoint (`/v7/finance/news?symbols=X`) returns 500 for Indian symbols — **not usable**.

---

## 2. Zerodha Kite Connect

**Premium OHLCV source. Requires paid Kite Connect subscription (~Rs 2000/mo).**

| Attribute | Value |
|---|---|
| **Base URL** | `https://api.kite.trade` |
| **Auth** | API key + access token (daily refresh), passed encrypted via credential vault |
| **Subscription** | ₹2000/month Kite Connect app plus Historical Data add-on |
| **Client code** | `src/engine/zerodhaFetcher.js` |
| **Worker proxy** | `POST /zerodha/historical`, `POST /zerodha/session`, `POST /zerodha/validate` |
| **On/off control** | Settings → Data Source → "Zerodha Kite"; falls back to Yahoo on auth failure |

### Endpoints consumed

- **`/instruments/NSE`** — Instrument master (symbol → instrument_token). Cached in Worker KV.
- **`/instruments/historical/{token}/{interval}?from=X&to=Y`** — OHLCV.
- **`/session/token`** — Exchange request_token for access_token (one-time login).
- **`/user/profile`** — Validate access_token is live.

### Cached?

- Instrument master: Worker KV, 24h TTL.
- OHLCV: Not cached (always fresh).
- Access token: Encrypted in browser localStorage via `credentialVault.js` (RSA-OAEP + AES-256-GCM).

### Known issues

- Access token **expires daily** at ~6 AM IST. Must be refreshed via OAuth flow or manual paste.
- "Historical Data" permission is a separate add-on; without it, `/historical` returns 403 and the app auto-falls-back to Yahoo.

---

## 3. Dhan HQ

**Alternative premium OHLCV source. Requires paid Dhan Data API subscription (~Rs 499/mo).**

| Attribute | Value |
|---|---|
| **Base URL** | `https://api.dhan.co`, `https://auth.dhan.co`, `https://images.dhan.co` |
| **Auth** | Client ID + PIN + TOTP → access token (daily); OR pasted access token |
| **Subscription** | ₹499/month Dhan Data API |
| **Client code** | `src/engine/dhanFetcher.js`, `src/engine/dhanInstruments.js` |
| **Worker proxy** | `POST /dhan/session`, `POST /dhan/historical`, `POST /dhan/validate`, `GET /dhan/instruments` |
| **On/off control** | Settings → Data Source → "Dhan"; falls back to Yahoo on auth failure |

### Endpoints consumed

- **`auth.dhan.co/app/generateAccessToken`** — PIN + TOTP → access token (daily auth).
- **`api.dhan.co/v2/charts/intraday`** — Intraday OHLCV (1m/5m/15m/25m/1h).
- **`api.dhan.co/v2/charts/historical`** — Daily OHLCV.
- **`api.dhan.co/v2/fundlimit`** — Token validation.
- **`images.dhan.co/api-data/api-scrip-master.csv`** — Full 32MB instrument master CSV (fetched once/week server-side).

### Cached?

- **Instrument master**: Fetched by Worker once a week, cached in KV, served to browser on Dhan token connect. Browser stores the full map in localStorage indefinitely (no expiry). Manual refresh via Settings button.
- **OHLCV**: Not cached.
- **Access token**: Encrypted in browser vault (same as Zerodha).
- **Client ID & PIN**: Plain localStorage (user convenience; not sensitive).

### Known issues

- **No news, alerts, or corporate announcements API** — Dhan's web app shows news in the Watchlist section but it's not exposed via the public v2 API. Their API only covers trading + market data.
- **Rate limits**: Unclear from docs. Empirically ~4-5 concurrent requests before 429s. Batch scan retries failed requests with 1s/2s/4s backoffs.
- **Token expires daily** at market open.
- **TOTP auth requires TOTP setup** on your Dhan account first.

---

## 4. NSE Public API

**Free NSE data: index constituents, FII/DII flows, and more. Requires Referer header workaround.**

| Attribute | Value |
|---|---|
| **Base URL** | `https://www.nseindia.com/api` |
| **Auth** | None, but requires `Referer: https://www.nseindia.com/` header and a session cookie from the home page |
| **Rate limit** | None documented; aggressive scraping gets soft-blocked |
| **Client code** | `src/engine/nseIndexFetch.js`, `src/data/dynamicIndices.js`, `scripts/lib/nse-http.mjs` |
| **Worker proxy** | Generic proxy at `GET /?u=<nse-url>` adds the required Referer. |
| **On/off control** | Always on for index constituent lookups. |

### Endpoints consumed

- **`/api/equity-stockIndices?index={NAME}`** — Constituents of any NSE index. Used for: NIFTY 50, NIFTY 100, NIFTY 200, NIFTY SMALLCAP 50/100/250, NIFTY MIDCAP 50/100/150, NIFTY TOTAL MARKET, plus all 17 sector indices (BANK, IT, AUTO, FMCG, PHARMA, METAL, REALTY, ENERGY, MEDIA, INFRA, PSE, FIN SERVICES, CONSUMER DURABLES, HEALTHCARE, OIL & GAS, PRIVATE BANK, PSU BANK).
- **`/api/live-analysis-variations?index=gainers`** / **`?index=losers`** — Top gainers / top losers (dynamic indices, live or last session).
- **`/api/fiidiiTradeReact`** — Current day FII and DII buy/sell/net values in Rs crore. Returns a 2-row array for the latest session. **No historical** — the `/api/historical/fiidii...` endpoints all return 404.

### Cached?

- **Index constituents**: Browser `sessionStorage` with 45-minute TTL (`src/engine/nseIndexFetch.js`).
- **Sector mappings**: Static JS map in `src/engine/sectorMap.js` (208 stocks), generated once by running the NSE fetch script. **Regenerate quarterly** when NSE rebalances.
- **FII/DII**: Not cached. Fetched on demand during live scans. Backtest flow values are populated from `cache/flow/<date>.json` if present (you populate manually).

### Known issues

- NSE session cookies expire. The Worker proxy fetches the home page first to get fresh cookies before the API call.
- Historical FII/DII is not available via any endpoint I could find. Backtest can't use this layer without manually cached values.

---

## 5. GitHub Releases API

**Version check for update notifications.**

| Attribute | Value |
|---|---|
| **Base URL** | `https://api.github.com` |
| **Auth** | None (public repo) |
| **Rate limit** | 60 req/hour unauthenticated |
| **Client code** | `src/components/UpdatePrompt.jsx` |
| **Worker proxy** | `GET /github/releases?repo={owner/repo}` — adds User-Agent header |
| **On/off control** | Hard-coded on; runs once per 24h automatically |

### Endpoints consumed

- **`/repos/utkarsh9891/candlescan/releases?per_page=1`** — Latest release tag. Compared against `__APP_VERSION__` baked in at build time. Shows "Update available" banner if newer.

### Cached?

- **localStorage**: Last check timestamp + latest known version. Prevents re-polling more than once per 24h.

### Known issues

- VPN / CORS blocks direct browser access to GitHub API on some Indian ISPs. The Worker proxy fallback handles this.

---

## 6. Cloudflare Worker (in-house proxy)

**Central proxy for all CORS-blocked or auth-protected external APIs.**

| Attribute | Value |
|---|---|
| **URL** | `https://candlescan-proxy.utkarsh-dev.workers.dev` |
| **Code** | `worker/index.js` |
| **Deploy** | `cd worker && npx wrangler deploy` |
| **Secrets** | `GATE_PASSPHRASE_HASH`, `GATE_PRIVATE_KEY` (Cloudflare env vars) |
| **KV bindings** | `RATE_LIMIT` (per-IP counters), `CANDLESCAN_KV` (public key, instrument masters) |
| **On/off control** | Always on in production; dev server uses Vite proxies to bypass. |

### Endpoints exposed

**Gate & vault**
- `POST /gate/unlock` — Validate passphrase hash, return RSA public key
- `POST /gate/validate` — Check if a hash is valid without unlocking

**Zerodha Kite** (encrypted passthrough)
- `POST /zerodha/session` — Exchange request_token for access_token
- `POST /zerodha/historical` — Decrypted-passthrough to `/instruments/historical/*`
- `POST /zerodha/validate` — Validate access token

**Dhan HQ** (encrypted passthrough)
- `POST /dhan/session` — PIN+TOTP → access_token
- `POST /dhan/historical` — Decrypted-passthrough to `/charts/*`
- `POST /dhan/validate` — Validate access token
- `GET /dhan/instruments` — Serve full NSE scrip master JSON (7-day KV cache)

**Generic proxies**
- `GET /github/releases?repo=X` — GitHub API passthrough
- `GET /?u=<url>` — Generic Yahoo/NSE passthrough (allowlisted host checks)

### Rate limiting

- 20 req/day per IP (free tier) for anonymous users
- Unlimited for users with valid gate token
- KV keys: `rl:{SHA256(ip)}:{YYYY-MM-DD}`, TTL 86400s

---

## 7. Market Context Signals (multi-factor)

**Day-level signals combined in `src/engine/marketContext.js` and fed into the risk engine's confidence + veto logic.**

| Layer | Source | Backtest data available? | LIVE data available? | Hard veto? | Positive bonus? |
|---|---|:---:|:---:|:---:|:---:|
| **India VIX regime** | Yahoo `^INDIAVIX` 1d close | ✅ 59d cached | ✅ live | ✅ PANIC >= 28 | ❌ |
| **Pre-market gap** | derived (prev close vs today open) | ✅ | ✅ | ❌ | ❌ |
| **Liquidity tier** | derived (per-bar avg volume) | ✅ | ✅ | ✅ TIER_D < 500/bar | ❌ |
| **FII/DII flow** | NSE `/api/fiidiiTradeReact` | ❌ no historical | ✅ live | ❌ | ❌ |
| **News sentiment** | _not yet fetched automatically_ | ❌ | ⚠️ needs source | ✅ counter-STRONG | ✅ +2 mild, +5 strong |

### Composition rules

The composer in `marketContext.js` operates primarily in **veto-only mode** for VIX, gap, liquidity, flow (zero confidence delta) because empirical sweeps showed positive bonuses shift candidate ranking and displace high-quality winners with marginally-boosted losers. **News is the exception** — it gets positive bonuses in both directions (aligned news favors the trade, counter-STRONG news vetoes it) because news is the strongest predictive signal when present.

### News data sources — options for populating the news layer

Dhan's public API does **not** expose news (their watchlist news is a web-only feature). Alternatives:

| Source | Cost | Coverage | Integration effort |
|---|---|---|---|
| **Google News RSS** | Free | Any query, global | Low — RSS parsing, free-text sentiment |
| **Moneycontrol / LiveMint RSS** | Free | Indian market | Low — RSS parsing |
| **NSE corporate announcements** | Free | Official filings only | Medium — XML parsing |
| **Yahoo Finance search** | Free | Unreliable (returns generic news) | Tried, doesn't work |
| **Yahoo Finance per-symbol news** | Free | 500 errors on Indian symbols | Tried, doesn't work |
| **NewsAPI.org** | Free tier 100/day | Global English news | Low — REST API |
| **RavenPack** | Paid, enterprise | Pre-scored sentiment | N/A |
| **StockTwits API** | Free tier | Social sentiment | Low — REST API |

**Recommended**: Google News RSS + a simple keyword-based sentiment scorer. Free, works for Indian symbols, and gives reasonable directional sentiment from headline + summary text without requiring a paid sentiment service.

### FII/DII data source

- **Live**: NSE's `/api/fiidiiTradeReact` returns current day values. Works.
- **Historical**: NSE historical endpoints all return 404. No free historical source found. Options: paid data provider, or manually scrape from the NSE reports PDFs.

---

## Summary Matrix

| Integration | Purpose | Dev usage | Prod usage | Cached | On/off control |
|---|---|:---:|:---:|:---:|---|
| Yahoo Chart API | OHLCV (primary) | Yes (disk) | Yes (no cache) | Dev only | Always on as fallback |
| Yahoo Quote API | Bid/ask, live price | Yes | Yes | No | Paper Trading only |
| Zerodha Kite | OHLCV (premium) | Yes via Worker | Yes via Worker | Instruments only | Settings → Data Source |
| Dhan HQ | OHLCV (premium) | Yes via Worker | Yes via Worker | Instruments only | Settings → Data Source |
| NSE stockIndices | Index constituents | Yes | Yes via Worker | Session (45m) | Always on |
| NSE FII/DII | Institutional flow | Live only | Live only | No | Passive (no explicit control) |
| GitHub Releases | Update check | Yes | Yes via Worker | 24h localStorage | Settings → Check for updates |
| Cloudflare Worker | Proxy hub | Dev bypasses | Yes | Internal KV | Deployed once, always on |
| India VIX | Regime filter | Yes | Live fetch | 59d disk cache | Automatic, hardcoded thresholds |
| News sentiment | Bullish/bearish bias | ❌ empty | ❌ empty (needs source) | `cache/news/<date>.json` | Automatic when present |

### What's currently ON in backtest

- Yahoo Chart (primary)
- NSE stockIndices (sector + index constituents)
- India VIX (cached)
- Gap (derived)
- Liquidity (derived)

### What's currently OFF in backtest (data not populated)

- News sentiment (no fetcher yet — would require building a Google News RSS pipeline or similar)
- FII/DII historical (no source available; live-only)

### What's ON in live scanning

All of the above PLUS:
- Zerodha or Dhan (if configured as data source)
- FII/DII live from NSE
- GitHub Releases (update check)

### What still needs to be built

1. **News fetcher** — Google News RSS + simple sentiment scoring. Populates `cache/news/<date>.json` so backtest can use the layer and live scan has real data.
2. **FII/DII live integration** — Call NSE's `/api/fiidiiTradeReact` on scan start in BatchScanPage / PaperTradingPage, populate `marketContext.flow` for the current session.
3. **VIX live fetch** — Currently only cached. Add a live fetch to get current-minute VIX during live scanning so PANIC regime can veto on spikes.
