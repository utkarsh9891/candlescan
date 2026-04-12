/**
 * Novice Mode — one button, plain-english trade recommendations.
 *
 * Designed for someone who:
 *   - Has zero market context
 *   - Follows zero news feeds
 *   - Knows zero technical analysis
 *   - Just wants to open the app at 9:20am, tap one button, take the
 *     trades it suggests, and close the app by 11:00am.
 *
 * Two surfaces:
 *   1. "Trade Now" — stocks the engine says to enter immediately, with
 *      plain-english instructions (buy at X, sell at Y, get out if it
 *      falls to Z, max time by HH:MM).
 *   2. "Watch List" — stocks that aren't ready yet but are forming up,
 *      with a one-line hint ("building a long setup — watch it"). The
 *      watch list auto-refreshes silently every ~75 seconds so the
 *      novice never has to tap Scan again unless they want a full
 *      fresh index scan.
 *
 * When a watch-list stock crosses the actionable threshold during
 * auto-refresh, it gets promoted to "Trade Now" with a "NEW" badge so
 * the user notices.
 *
 * This view is a LEAF in the app — it never modifies scan/engine
 * state on the main stock scanner. Tapping a card opens that stock
 * on the main view (same entry point as Batch Scanner results).
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { batchScan } from '../engine/batchScan.js';
import { detectPatterns as detectPatternsScalp } from '../engine/patterns-scalp.js';
import { detectLiquidityBox as detectLiquidityBoxScalp } from '../engine/liquidityBox-scalp.js';
import { computeRiskScore as computeRiskScoreScalp } from '../engine/risk-scalp.js';
import { detectProximity, classifyForNovice, PROXIMITY_TIERS } from '../engine/proximity-scalp.js';
import { getIndexDirection } from '../engine/indexDirection.js';
import { fetchLiveMarketContext } from '../engine/marketContextLive.js';
import { fetchNseIndexSymbolList } from '../engine/nseIndexFetch.js';
import { createFetchFn } from '../engine/dataSourceFetch.js';
import { getGateToken, setGateToken, hasGateToken, clearGateToken } from '../utils/batchAuth.js';
import { DEFAULT_NSE_INDEX_ID, NSE_INDEX_OPTIONS } from '../config/nseIndices.js';
import {
  PassphraseModal, TradeNowCard, WatchCard, EmptyPanel, SectionHeader,
} from './NoviceCards.jsx';

// App owner defaults per CLAUDE.md
const DEFAULT_CAPITAL = 300000;       // Rs 3 lakh
const MARGIN_MULT = 5;                // 5x → Rs 15 lakh exposure

// Virtual "combined" index — Novice Mode's default. Unions the three
// liquid NIFTY 100s (top / mid / small) into ~300 tradable stocks.
// Handled inline by runFullScan: fetches each component index in
// parallel and unions the symbol lists before passing to batchScan.
// Not added to nseIndices.js because no other view uses it.
const COMBINED_INDEX_ID = 'TOP + MID + SMALL 100';
const COMBINED_INDEX_LABEL = 'Top + Mid + Small 100 (~300 stocks)';
const COMBINED_INDEX_COMPONENTS = ['NIFTY 100', 'NIFTY MIDCAP 100', 'NIFTY SMALLCAP 100'];
// Parent index used for getIndexDirection when the combined universe
// is selected — NIFTY 100's parent is ^NSEI (via indexDirection.js map).
const COMBINED_INDEX_DIRECTION_PROXY = 'NIFTY 100';

// Novice mode ONLY uses the scalp momentum engine. Variants are an
// advanced-user concern; exposing them would confuse the target user.
const NOVICE_ENGINE_FNS = {
  detectPatterns: detectPatternsScalp,
  detectLiquidityBox: detectLiquidityBoxScalp,
  computeRiskScore: computeRiskScoreScalp,
  detectProximity, // enables watch-list classification inside batchScan
};

// Auto-refresh cadence for the watch list. 75s avoids the :00/:30 mark
// and is slow enough not to burn rate limits on top-20 re-scans.
const AUTO_REFRESH_MS = 75 * 1000;
// Watch list re-scans this many top promising symbols per refresh.
const REFRESH_UNIVERSE_SIZE = 20;
// How long a newly-promoted card wears its "NEW" highlight.
const NEW_HIGHLIGHT_MS = 45 * 1000;

// Sub-components (TradeNowCard, WatchCard, PassphraseModal, EmptyPanel,
// SectionHeader, formatting helpers) extracted to NoviceCards.jsx for
// file-size manageability.

// ── Main component ──────────────────────────────────────────────────

export default function NoviceModePage({
  savedIndex, onIndexChange, indexOptions, dataSource, onSelectSymbol,
  scheduledChecks,
}) {
  const [scanning, setScanning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0, current: '' });
  const [results, setResults] = useState([]);            // latest full-scan results
  const [lastScanAt, setLastScanAt] = useState(null);
  const [error, setError] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  // NEW-badge tracking: map of symbol → expiresAt timestamp
  const [promotedUntil, setPromotedUntil] = useState({});
  // Default to the combined Top + Mid + Small 100 universe. It's the
  // virtual index — ~300 liquid large/mid/small caps handled inline
  // by runFullScan. Users can switch to any single built-in index via
  // the dropdown below if they want narrower scope.
  const [novIndex, setNovIndex] = useState(COMBINED_INDEX_ID);

  // Dropdown options: virtual combined at top + everything from the
  // app's regular index options.
  const dropdownOptions = [
    { id: COMBINED_INDEX_ID, label: COMBINED_INDEX_LABEL },
    ...(indexOptions || NSE_INDEX_OPTIONS),
  ];
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Capital used for trade sizing. Matches CLAUDE.md default, user
  // can tweak in settings later; exposed here as a local state so a
  // casual user can bump it without leaving the page.
  const [capital, setCapital] = useState(DEFAULT_CAPITAL);

  const abortRef = useRef(null);
  const indexDirRef = useRef(null);     // cached between full + refresh scans
  const marketCtxRef = useRef(null);

  // Prune expired NEW badges
  useEffect(() => {
    if (!Object.keys(promotedUntil).length) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setPromotedUntil((prev) => {
        let changed = false;
        const next = {};
        for (const [sym, until] of Object.entries(prev)) {
          if (until > now) next[sym] = until;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 5000);
    return () => clearInterval(timer);
  }, [promotedUntil]);

  // Live clock so the "last scanned X minutes ago" line stays fresh
  const [nowTs, setNowTs] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const runFullScan = useCallback(async (token) => {
    setScanning(true);
    setError('');
    setResults([]);
    setProgress({ completed: 0, total: 0, current: 'Loading stocks…' });

    try {
      // Resolve symbols — either from a single index or from the
      // virtual combined universe. The combined path fetches all
      // three components in parallel and unions them, with per-fetch
      // error tolerance so one failure doesn't kill the scan.
      let symbols;
      if (novIndex === COMBINED_INDEX_ID) {
        const lists = await Promise.all(
          COMBINED_INDEX_COMPONENTS.map(id =>
            fetchNseIndexSymbolList(id).catch(() => [])
          )
        );
        const union = new Set();
        for (const list of lists) for (const s of list) union.add(s);
        symbols = Array.from(union);
      } else {
        symbols = await fetchNseIndexSymbolList(novIndex);
      }
      if (!symbols?.length) {
        setError('Could not load the stock list. Try again in a minute.');
        return;
      }
      setProgress({ completed: 0, total: symbols.length, current: symbols[0] });

      // For the combined universe, use NIFTY 100 as the proxy for
      // market-direction detection (indexDirection.js maps it to ^NSEI).
      const dirIdx = novIndex === COMBINED_INDEX_ID ? COMBINED_INDEX_DIRECTION_PROXY : novIndex;
      let indexDirection = null;
      try { indexDirection = await getIndexDirection(dirIdx); } catch { /* ok */ }
      indexDirRef.current = indexDirection;

      let marketContext = null;
      try {
        const universe = new Set(symbols.map(s => String(s).toUpperCase().replace(/\.NS$/, '')));
        marketContext = await fetchLiveMarketContext(universe);
      } catch { /* ok */ }
      marketCtxRef.current = marketContext;

      const controller = new AbortController();
      abortRef.current = controller;

      const scan = await batchScan({
        symbols,
        timeframe: '1m',
        gateToken: token,
        engineFns: NOVICE_ENGINE_FNS,
        indexDirection,
        marketContext,
        concurrency: 8,
        delayMs: 0,
        onProgress: (completed, total, current) => setProgress({ completed, total, current }),
        onResult: (r) => {
          setResults(prev => {
            const next = [...prev, r];
            // Sort so the trade-now cards float up immediately.
            next.sort(sortResults);
            return next;
          });
        },
        signal: controller.signal,
        fetchFn: createFetchFn(dataSource || 'yahoo'),
      });
      setLastScanAt(Date.now());
      // After the full array returns, sort canonically (onResult sorted
      // partial state — re-sort once more for stability).
      if (Array.isArray(scan)) {
        setResults(scan.slice().sort(sortResults));
      }
    } catch (e) {
      const msg = e?.message || String(e);
      if (msg.includes('403')) {
        clearGateToken();
        setError('Passphrase rejected. Tap the button to try again.');
      } else if (e?.name !== 'AbortError') {
        setError(msg);
      }
    } finally {
      setScanning(false);
      abortRef.current = null;
    }
  }, [novIndex, dataSource]);

  // Lightweight re-scan of just the top promising symbols. Called
  // by the auto-refresh timer and when the user taps a refresh affordance.
  const runWatchRefresh = useCallback(async () => {
    if (scanning || refreshing) return;
    if (!results.length) return;
    if (!hasGateToken()) return;

    // Take the top N most interesting symbols (by sort order) — already
    // includes both actionable and watch-list candidates.
    const topSymbols = results.slice(0, REFRESH_UNIVERSE_SIZE).map(r => r.symbol);
    if (!topSymbols.length) return;

    setRefreshing(true);
    try {
      const token = getGateToken();
      const updated = await batchScan({
        symbols: topSymbols,
        timeframe: '1m',
        gateToken: token,
        engineFns: NOVICE_ENGINE_FNS,
        indexDirection: indexDirRef.current,
        marketContext: marketCtxRef.current,
        concurrency: 8,
        delayMs: 0,
        fetchFn: createFetchFn(dataSource || 'yahoo'),
      });

      // Merge: replace matching symbols, keep the rest. Detect promotions
      // (went from non-trade-now → trade-now) and set their NEW badges.
      setResults(prev => {
        const byNewSym = new Map();
        for (const r of updated) byNewSym.set(r.symbol, r);
        const prevByNewSym = new Map();
        for (const r of prev) prevByNewSym.set(r.symbol, r);

        const now = Date.now();
        const newlyPromoted = {};
        const merged = prev.map(r => {
          const nu = byNewSym.get(r.symbol);
          if (!nu) return r;
          const wasTrade = classifyForNovice(r, r.proximityInfo) === 'trade-now';
          const isTrade = classifyForNovice(nu, nu.proximityInfo) === 'trade-now';
          if (!wasTrade && isTrade) {
            newlyPromoted[r.symbol] = now + NEW_HIGHLIGHT_MS;
          }
          return nu;
        });
        merged.sort(sortResults);
        if (Object.keys(newlyPromoted).length) {
          setPromotedUntil(prevP => ({ ...prevP, ...newlyPromoted }));
        }
        return merged;
      });
      setLastScanAt(Date.now());
    } catch {
      /* silent — auto-refresh failures should never interrupt the user */
    } finally {
      setRefreshing(false);
    }
  }, [results, scanning, refreshing, dataSource]);

  // Auto-refresh loop
  useEffect(() => {
    if (!autoRefresh) return;
    if (!results.length) return;
    const timer = setInterval(() => {
      runWatchRefresh();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, results.length, runWatchRefresh]);

  const handleScanClick = useCallback(() => {
    if (scanning) {
      abortRef.current?.abort();
      return;
    }
    if (!hasGateToken()) {
      setShowPassphrase(true);
      return;
    }
    runFullScan(getGateToken());
  }, [scanning, runFullScan]);

  const handlePassphraseSubmit = useCallback(async (pass) => {
    try {
      await setGateToken(pass);
      setShowPassphrase(false);
      runFullScan(getGateToken());
    } catch {
      setError('Could not save passphrase. Try again.');
    }
  }, [runFullScan]);

  // ── Partition results into buckets for rendering ────────────────
  const tradeNow = [];
  const imminent = [];
  const building = [];
  const early = [];
  const now = Date.now();
  for (const r of results) {
    const cat = classifyForNovice(r, r.proximityInfo);
    if (cat === 'trade-now') tradeNow.push(r);
    else if (cat === 'imminent') imminent.push(r);
    else if (cat === 'building') building.push(r);
    else if (cat === 'early') early.push(r);
  }
  // Cap watch list size per tier to keep the screen digestible.
  const WATCH_CAP = 6;
  const imminentShown = imminent.slice(0, WATCH_CAP);
  const buildingShown = building.slice(0, WATCH_CAP);
  const earlyShown = early.slice(0, Math.min(4, WATCH_CAP));

  const lastScanAgo = lastScanAt ? Math.round((nowTs - lastScanAt) / 1000) : null;
  const lastScanAgoLabel = lastScanAgo == null
    ? ''
    : lastScanAgo < 45
      ? 'just now'
      : lastScanAgo < 120
        ? 'a minute ago'
        : `${Math.round(lastScanAgo / 60)} min ago`;

  return (
    <div>
      {showPassphrase && (
        <PassphraseModal
          onSubmit={handlePassphraseSubmit}
          onCancel={() => setShowPassphrase(false)}
        />
      )}

      {/* Hero panel */}
      <div style={{
        padding: 16, borderRadius: 14, marginBottom: 12,
        background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
        color: '#fff',
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', letterSpacing: 1, marginBottom: 4 }}>
          NOVICE MODE
        </div>
        <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.2, marginBottom: 6 }}>
          Tap one button. Take the trades.
        </div>
        <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.5, marginBottom: 14 }}>
          The app scans the whole index, filters for high-conviction 1-minute setups,
          and gives you plain instructions. No charts or jargon required.
        </div>

        <button
          type="button"
          onClick={handleScanClick}
          style={{
            width: '100%', padding: '16px 0', fontSize: 16, fontWeight: 800,
            borderRadius: 12, border: 'none', cursor: 'pointer',
            background: scanning ? '#dc2626' : '#22c55e',
            color: '#fff', letterSpacing: 0.5,
            boxShadow: scanning ? '0 4px 16px rgba(220,38,38,0.4)' : '0 4px 16px rgba(34,197,94,0.4)',
          }}
        >
          {scanning ? '⏹  CANCEL SCAN' : results.length ? '🔄  SCAN AGAIN' : '⚡  FIND TRADES NOW'}
        </button>

        {/* Compact settings strip */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginTop: 12,
          fontSize: 11, color: '#cbd5e1', flexWrap: 'wrap',
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>Scanning</span>
            <select
              value={novIndex}
              onChange={(e) => {
                const v = e.target.value;
                setNovIndex(v);
                // Sync real (non-combined) indices globally so other
                // views pick up the same selection.
                if (v !== COMBINED_INDEX_ID && onIndexChange) onIndexChange(v);
              }}
              disabled={scanning}
              style={{
                padding: '4px 6px', fontSize: 11, borderRadius: 6,
                background: '#1e293b', color: '#fff', border: '1px solid #334155',
                fontWeight: 600,
              }}
            >
              {dropdownOptions.map(o => (
                <option key={o.id} value={o.id}>{o.label || o.id}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>Capital</span>
            <select
              value={capital}
              onChange={(e) => setCapital(Number(e.target.value))}
              style={{
                padding: '4px 6px', fontSize: 11, borderRadius: 6,
                background: '#1e293b', color: '#fff', border: '1px solid #334155',
                fontWeight: 600,
              }}
            >
              <option value={100000}>1L</option>
              <option value={200000}>2L</option>
              <option value={300000}>3L</option>
              <option value={500000}>5L</option>
              <option value={1000000}>10L</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              style={{ margin: 0 }}
            />
            <span title="Re-scans the top 20 promising stocks every ~75s. If one becomes actionable, it promotes with a NEW badge.">Auto re-check every ~1 min</span>
          </label>
        </div>
      </div>

      {/* Progress indicator */}
      {scanning && (
        <div style={{ marginBottom: 12 }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            fontSize: 11, color: '#4a5068', marginBottom: 4,
          }}>
            <span>Scanning {progress.completed}/{progress.total}…</span>
            {progress.current && (
              <span style={{ fontFamily: mono, color: '#8892a8' }}>{progress.current}</span>
            )}
          </div>
          <div style={{ height: 4, borderRadius: 2, background: '#e2e5eb', overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: progress.total ? `${(progress.completed / progress.total) * 100}%` : '0%',
              background: '#22c55e',
              transition: 'width 0.3s ease',
            }} />
          </div>
        </div>
      )}

      {/* Refresh indicator (subtle — doesn't take over) */}
      {refreshing && !scanning && (
        <div style={{
          fontSize: 10, color: '#8892a8', textAlign: 'center', marginBottom: 8,
          fontStyle: 'italic',
        }}>
          Refreshing watch list…
        </div>
      )}

      {error && (
        <div style={{
          padding: 14, borderRadius: 10, background: '#fef2f2',
          border: '1px solid #fecaca', color: '#991b1b',
          fontSize: 13, lineHeight: 1.5, marginBottom: 12,
        }}>
          {error}
        </div>
      )}

      {/* First-use empty state — shown before the first scan */}
      {!scanning && !lastScanAt && !error && (
        <div style={{
          padding: 20, borderRadius: 14, background: '#fff',
          border: '1px solid #e2e5eb', marginBottom: 12,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#1a1d26', marginBottom: 6 }}>
            How this works
          </div>
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#4a5068', lineHeight: 1.7 }}>
            <li>Tap <strong>Find Trades Now</strong>. The app checks every stock in your index.</li>
            <li>Any green <strong>BUY</strong> / red <strong>SHORT</strong> card is an entry you can take right now.</li>
            <li>Each card tells you the entry price, target, stop-loss, and time limit — in rupees.</li>
            <li>Stocks that are <em>almost</em> ready show up in the Watch List. Leave auto-refresh on
                and the app will re-check them for you.</li>
            <li>Trade only between <strong>9:30 and 11:00 AM</strong>. Exit all positions by 11:00 AM regardless.</li>
          </ol>
        </div>
      )}

      {/* Scan complete but zero results — explicit "nothing found" so it
          doesn't look like the scan silently failed */}
      {!scanning && lastScanAt && results.length === 0 && !error && (
        <div style={{
          padding: 20, borderRadius: 14, background: '#fffbeb',
          border: '1px solid #fde68a', marginBottom: 12,
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 22, marginBottom: 8 }}>🔍</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#92400e', marginBottom: 6 }}>
            Scan complete — no trades right now
          </div>
          <div style={{ fontSize: 12, color: '#a16207', lineHeight: 1.5 }}>
            Nothing met the criteria this time. The market might not be moving enough yet,
            or it could be outside the 9:30–11:00 trading window. Try again in a couple of minutes.
          </div>
        </div>
      )}

      {/* Last-scan status (after first scan) */}
      {!scanning && results.length > 0 && lastScanAt && (
        <div style={{
          fontSize: 11, color: '#8892a8', textAlign: 'right',
          marginBottom: 4, marginTop: -4,
        }}>
          Last scan {lastScanAgoLabel} · {tradeNow.length} to trade · {imminent.length + building.length + early.length} to watch
        </div>
      )}

      {/* TRADE NOW section */}
      {results.length > 0 && (
        <>
          <SectionHeader
            title={`🟢 TRADE NOW (${tradeNow.length})`}
            color="#16a34a"
          />
          {tradeNow.length === 0 ? (
            <EmptyPanel text="Nothing ready to trade right this second. Check the watch list below, or scan again in a minute or two." />
          ) : (
            tradeNow.map((r) => (
              <TradeNowCard
                key={r.symbol}
                r={r}
                capital={capital}
                onTap={onSelectSymbol}
                isNew={promotedUntil[r.symbol] && promotedUntil[r.symbol] > now}
              />
            ))
          )}
        </>
      )}

      {/* IMMINENT section */}
      {results.length > 0 && imminentShown.length > 0 && (
        <>
          <SectionHeader
            title={`⚡ ALMOST THERE (${imminent.length})`}
            color="#d97706"
          />
          {imminentShown.map((r) => (
            <WatchCard key={r.symbol} r={r} onTap={onSelectSymbol} category="imminent" scheduledChecks={scheduledChecks} />
          ))}
        </>
      )}

      {/* BUILDING section */}
      {results.length > 0 && buildingShown.length > 0 && (
        <>
          <SectionHeader
            title={`👀 BUILDING (${building.length})`}
            color="#64748b"
          />
          {buildingShown.map((r) => (
            <WatchCard key={r.symbol} r={r} onTap={onSelectSymbol} category="building" scheduledChecks={scheduledChecks} />
          ))}
        </>
      )}

      {/* EARLY section — only show a few */}
      {results.length > 0 && earlyShown.length > 0 && (
        <>
          <SectionHeader
            title={`🌱 EARLY HINTS (${early.length})`}
            color="#94a3b8"
          />
          {earlyShown.map((r) => (
            <WatchCard key={r.symbol} r={r} onTap={onSelectSymbol} category="early" scheduledChecks={scheduledChecks} />
          ))}
        </>
      )}

      <div style={{
        marginTop: 24, fontSize: 10, color: '#94a3b8',
        textAlign: 'center', lineHeight: 1.5,
      }}>
        Educational tool only — not financial advice. Past performance does
        not predict future results. You are responsible for your trades.
      </div>
    </div>
  );
}

// ── Result sort order (local to novice mode) ──────────────────────
// Trade-now first, then imminent, then by proximity/confidence desc.
const ACTION_RANK = {
  'STRONG BUY': 5, 'STRONG SHORT': 5,
  BUY: 4, SHORT: 4,
  WAIT: 2, 'NO TRADE': 1,
};

function sortResults(a, b) {
  const ra = ACTION_RANK[a.action] || 0;
  const rb = ACTION_RANK[b.action] || 0;
  if (ra !== rb) return rb - ra;
  // Within same tier: trade-now by confidence, watch list by proximity
  const pa = a.proximityInfo?.proximity ?? 0;
  const pb = b.proximityInfo?.proximity ?? 0;
  // If either is actionable, rank by confidence
  if (ra >= 4) return (b.confidence ?? 0) - (a.confidence ?? 0);
  // Otherwise rank by proximity desc (with confidence as tiebreak)
  if (pa !== pb) return pb - pa;
  return (b.confidence ?? 0) - (a.confidence ?? 0);
}
