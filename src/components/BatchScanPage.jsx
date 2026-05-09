import { useState, useRef, useCallback, useEffect } from 'react';
import { NSE_INDEX_OPTIONS, DEFAULT_NSE_INDEX_ID, getCustomIndices } from '../config/nseIndices.js';
import { fetchNseIndexSymbolList } from '../engine/nseIndexFetch.js';
import { batchScan, resetBatchScanRateLimitState } from '../engine/batchScan.js';
import { fetchLiveMarketContext, enrichWithGoogleNews } from '../engine/marketContextLive.js';
import { getGateToken, hasGateToken, clearGateToken } from '../utils/batchAuth.js';
import { unlockGate } from '../utils/credentialVault.js';
import { createFetchFn } from '../engine/dataSourceFetch.js';
import { getMarketStatus } from '../utils/marketHours.js';
import { decideNextScan, getCadenceMs, cadenceLabel } from '../utils/scanScheduler.js';
import { saveScanResults, loadScanResults, clearScanResults } from '../utils/scanResultsCache.js';
// Engine-specific imports for engine-aware batch scanning
import { detectPatterns as detectPatternsScalp } from '../engine/patterns-scalp.js';
import { detectLiquidityBox as detectLiquidityBoxScalp } from '../engine/liquidityBox-scalp.js';
import { computeRiskScore as computeRiskScoreScalp } from '../engine/risk-scalp.js';
import { detectPatterns as detectPatternsV2 } from '../engine/patterns-v2.js';
import { detectLiquidityBox as detectLiquidityBoxV2 } from '../engine/liquidityBox-v2.js';
import { computeRiskScore as computeRiskScoreV2 } from '../engine/risk-v2.js';
import { detectPatterns as detectPatternsClassic } from '../engine/patterns-classic.js';
import { detectLiquidityBox as detectLiquidityBoxClassic } from '../engine/liquidityBox-classic.js';
import { computeRiskScore as computeRiskScoreClassic } from '../engine/risk-classic.js';
import { detectProximity, classifyForNovice } from '../engine/proximity-scalp.js';
import { getIndexDirection } from '../engine/indexDirection.js';
import ScheduleCheckButton from './ScheduleCheckButton.jsx';
import TokenExpiryBanner from './TokenExpiryBanner.jsx';

const mono = "'SF Mono', Menlo, monospace";
const ALL_TFS = ['1m', '5m', '15m', '30m', '1h', '1d'];

const ACTION_RANK = {
  'STRONG BUY': 5, 'STRONG SHORT': 5,
  BUY: 4, SHORT: 4,
  WAIT: 2, 'NO TRADE': 0,
};

function actionColor(action) {
  if (action === 'STRONG BUY' || action === 'BUY') return '#16a34a';
  if (action === 'STRONG SHORT' || action === 'SHORT') return '#dc2626';
  if (action === 'WAIT') return '#d97706';
  return '#8892a8';
}

function actionBg(action) {
  if (action === 'STRONG BUY' || action === 'BUY') return '#f0fdf4';
  if (action === 'STRONG SHORT' || action === 'SHORT') return '#fef2f2';
  if (action === 'WAIT') return '#fffbeb';
  return '#f5f6f8';
}

function PassphraseModal({ onSubmit, onCancel }) {
  const [val, setVal] = useState('');
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20,
    }}>
      <div style={{
        background: '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 340,
        boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
      }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Batch Scan Key</div>
        <div style={{ fontSize: 12, color: '#8892a8', marginBottom: 16 }}>
          Enter your passphrase to unlock index scanning.
        </div>
        <input
          type="password"
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && val.trim() && onSubmit(val.trim())}
          placeholder="Passphrase"
          style={{
            width: '100%', padding: '10px 12px', fontSize: 14, borderRadius: 8,
            border: '1px solid #e2e5eb', outline: 'none', boxSizing: 'border-box',
            marginBottom: 14,
          }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              flex: 1, padding: '10px 0', fontSize: 13, fontWeight: 600, borderRadius: 8,
              border: '1px solid #e2e5eb', background: '#fff', color: '#4a5068', cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => val.trim() && onSubmit(val.trim())}
            style={{
              flex: 1, padding: '10px 0', fontSize: 13, fontWeight: 600, borderRadius: 8,
              border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer',
              opacity: val.trim() ? 1 : 0.5,
            }}
          >
            Unlock
          </button>
        </div>
      </div>
    </div>
  );
}

/** Format a unix timestamp as HH:MM IST. */
function formatIstTime(ts) {
  if (!ts) return '';
  const d = new Date((ts + 19800) * 1000); // shift to IST wall clock
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** Is a signal still within its valid window? */
function isSignalFresh(r, nowSec = Math.floor(Date.now() / 1000)) {
  if (!r.validTillTs) return true; // no timestamp → assume fresh (legacy)
  return nowSec <= r.validTillTs;
}

function ResultCard({ r, onTap, scheduledChecks }) {
  const color = actionColor(r.action);
  const bg = actionBg(r.action);
  const fresh = isSignalFresh(r);
  // Classify for scheduling: show the schedule button on WAIT rows and
  // on near-threshold NO TRADE rows that have proximity info (scalp-engine
  // results only, since other engines don't populate proximityInfo).
  const noviceClass = classifyForNovice(r, r.proximityInfo);
  const canSchedule = noviceClass === 'imminent' || noviceClass === 'building' || noviceClass === 'early';
  const scheduleTier = noviceClass === 'building' ? 'building' : noviceClass === 'early' ? 'early' : 'wait';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onTap(r.symbol)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onTap(r.symbol); }}
      style={{
        width: '100%', textAlign: 'left', cursor: 'pointer',
        padding: 12, borderRadius: 10,
        border: fresh ? '1px solid #e2e5eb' : '1px dashed #cbd0d9',
        background: fresh ? '#fff' : '#fafbfc',
        display: 'block', marginBottom: 8,
        opacity: fresh ? 1 : 0.78,
        boxSizing: 'border-box',
      }}
    >
      {/* Row 1: Symbol + Action badge + Confidence */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>{r.symbol}</span>
          {r.companyName !== r.symbol && (
            <span style={{ fontSize: 11, color: '#8892a8', marginLeft: 6 }}>
              {r.companyName.length > 20 ? r.companyName.slice(0, 20) + '...' : r.companyName}
            </span>
          )}
        </div>
        {!fresh && (
          <span style={{
            fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 4,
            background: '#fef2f2', color: '#dc2626', whiteSpace: 'nowrap',
            border: '1px solid #fecaca', letterSpacing: 0.4,
          }}>
            EXPIRED
          </span>
        )}
        <span style={{
          fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
          background: bg, color, whiteSpace: 'nowrap',
        }}>
          {r.action}
        </span>
        <span style={{
          fontSize: 13, fontWeight: 700, fontFamily: mono, color,
          minWidth: 28, textAlign: 'right',
        }}>
          {r.confidence}
        </span>
      </div>
      {/* Row 2: Entry / SL / Target + R:R + Pattern */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: '#4a5068' }}>
        <span style={{ fontFamily: mono }}>
          E:{r.entry?.toFixed(1)} SL:{r.sl?.toFixed(1)} T:{r.target?.toFixed(1)}
        </span>
        <span style={{ fontFamily: mono, color: '#8892a8' }}>
          R:R {r.rr?.toFixed(1)}
        </span>
        <span style={{ marginLeft: 'auto', color: '#8892a8', fontStyle: 'italic' }}>
          {r.topPattern}
        </span>
      </div>
      {/* Row 3: Signal freshness — fire time + valid till */}
      {r.validTillTs && (
        <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: '#8892a8' }}>
          <span style={{ fontFamily: mono }}>
            Fired {formatIstTime(r.signalBarTs)}
          </span>
          <span style={{ fontFamily: mono, color: fresh ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
            {fresh ? `Valid till ${formatIstTime(r.validTillTs)}` : `Expired at ${formatIstTime(r.validTillTs)}`}
          </span>
        </div>
      )}
      {/* Row 4: Context tags — sector, VIX, news sentiment badge */}
      {(r.sector || r.vixRegime || r.newsSentiment) && (
        <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, flexWrap: 'wrap' }}>
          {r.sector && (
            <span style={{ padding: '1px 6px', borderRadius: 3, background: '#eef2ff', color: '#4338ca', fontWeight: 600 }}>
              {r.sector}
            </span>
          )}
          {r.vixRegime && (
            <span style={{ padding: '1px 6px', borderRadius: 3, background: '#f0f4ff', color: '#4a5068', fontWeight: 600 }}>
              VIX:{r.vixRegime}
            </span>
          )}
          {r.newsSentiment && r.newsSentiment !== 'NEUTRAL' && (
            <span style={{
              padding: '1px 6px', borderRadius: 3, fontWeight: 700,
              background: r.newsSentiment.includes('BULLISH') ? '#dcfce7' : '#fee2e2',
              color: r.newsSentiment.includes('BULLISH') ? '#166534' : '#991b1b',
            }}>
              NEWS: {r.newsSentiment}
              {typeof r.newsScore === 'number' && ` (${r.newsScore.toFixed(2)})`}
            </span>
          )}
        </div>
      )}
      {/* Row 5: News headlines — the actual text that drove the sentiment */}
      {r.newsHeadlines && r.newsHeadlines.length > 0 && (
        <div style={{ marginTop: 6, padding: '6px 8px', borderLeft: '3px solid #cbd5e1', background: '#f8fafc', borderRadius: '0 4px 4px 0' }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: '#64748b', marginBottom: 2, letterSpacing: 0.3 }}>
            RECENT NEWS ({r.newsHeadlines.length})
          </div>
          {r.newsHeadlines.slice(0, 3).map((h, i) => (
            <div key={i} style={{
              fontSize: 10, color: '#334155', lineHeight: 1.3, marginTop: i > 0 ? 3 : 0,
              display: 'flex', alignItems: 'flex-start', gap: 4,
            }}>
              <span style={{
                flexShrink: 0, fontFamily: mono, fontSize: 9, fontWeight: 700,
                color: h.score > 0.2 ? '#16a34a' : h.score < -0.2 ? '#dc2626' : '#94a3b8',
                minWidth: 32,
              }}>
                {h.score > 0 ? '+' : ''}{h.score.toFixed(2)}
              </span>
              {h.url ? (
                <a href={h.url} target="_blank" rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  style={{ color: '#334155', textDecoration: 'underline' }}
                  title={h.publisher ? `Open at ${h.publisher}` : 'Open article'}>
                  {h.title}
                </a>
              ) : (
                <span>{h.title}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {/* Row 6: Schedule Check — only for near-threshold rows so we don't
          pollute trade-now cards (which don't need a reminder). */}
      {canSchedule && scheduledChecks && (
        <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
          <ScheduleCheckButton
            scheduledChecks={scheduledChecks}
            symbol={r.symbol}
            company={r.companyName}
            direction={r.proximityInfo?.direction || r.direction}
            beforeClass={noviceClass}
            beforeHint={r.proximityInfo?.hint || (noviceClass === 'imminent' ? 'Close to firing' : 'Still forming')}
            tier={scheduleTier}
          />
        </div>
      )}
    </div>
  );
}

function getEngineFns(engineVersion) {
  if (engineVersion === 'scalp') return {
    detectPatterns: detectPatternsScalp,
    detectLiquidityBox: detectLiquidityBoxScalp,
    computeRiskScore: computeRiskScoreScalp,
    detectProximity, // so near-threshold rows get proximityInfo for the schedule button
  };
  if (engineVersion === 'delivery') return { detectPatterns: detectPatternsClassic, detectLiquidityBox: detectLiquidityBoxClassic, computeRiskScore: computeRiskScoreClassic };
  return { detectPatterns: detectPatternsV2, detectLiquidityBox: detectLiquidityBoxV2, computeRiskScore: computeRiskScoreV2 };
}

const AUTO_SCAN_KEY = 'cs.batchScan.autoScan';

/**
 * Status row for the Auto-scan toggle. Shows live cadence + market
 * state so the user knows what "on" actually does for their engine.
 */
function AutoScanRow({ engine, timeframe, autoScan, setAutoScan, scanning, lastScanAt }) {
  const cadence = getCadenceMs(engine, timeframe);
  const supported = cadence != null;
  const [marketTick, setMarketTick] = useState(() => getMarketStatus());
  useEffect(() => {
    const t = setInterval(() => setMarketTick(getMarketStatus()), 30000);
    return () => clearInterval(t);
  }, []);
  let statusText;
  if (!supported) {
    statusText = 'Auto-scan not available for delivery engine';
  } else if (!autoScan) {
    statusText = `Auto-scan off · cadence ${cadenceLabel(engine, timeframe)}`;
  } else if (!marketTick.isOpen) {
    statusText = `Auto-scan paused · market closed`;
  } else if (scanning) {
    statusText = `Auto-scan active · scanning now`;
  } else if (lastScanAt) {
    const ageS = Math.max(0, Math.round((Date.now() - lastScanAt) / 1000));
    const nextS = Math.max(0, Math.round((cadence - (Date.now() - lastScanAt)) / 1000));
    statusText = ageS < 5
      ? `Auto-scan active · just ran`
      : `Auto-scan active · next in ${nextS}s`;
  } else {
    statusText = `Auto-scan active · firing soon`;
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
      padding: '6px 10px', borderRadius: 8,
      background: supported && autoScan ? '#f0fdf4' : '#f8fafc',
      border: supported && autoScan ? '1px solid #bbf7d0' : '1px solid #e2e5eb',
    }}>
      <label style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: 11, fontWeight: 700, color: '#1a1d26',
        cursor: supported ? 'pointer' : 'not-allowed',
        opacity: supported ? 1 : 0.5,
      }}>
        <input
          type="checkbox"
          checked={autoScan && supported}
          disabled={!supported}
          onChange={(e) => setAutoScan(e.target.checked)}
          style={{ cursor: supported ? 'pointer' : 'not-allowed' }}
        />
        Auto-scan
      </label>
      <span style={{ fontSize: 10, color: '#64748b', flex: 1, textAlign: 'right' }}>
        {statusText}
      </span>
    </div>
  );
}

/**
 * Re-renders every second while a scan is in progress so the elapsed
 * counter stays live without polluting the parent component with a tick.
 */
function ScanElapsed({ startedAt }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (sec < 60) return <>{sec}s</>;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return <>{m}m {s}s</>;
}

export default function BatchScanPage({ onSelectSymbol, savedIndex, onIndexChange, indexOptions, engineVersion, dataSource, debugMode, scheduledChecks, onOpenSettings, newsEnrichEnabled = true }) {
  const allOptions = indexOptions || NSE_INDEX_OPTIONS;
  const nseIndex = savedIndex || DEFAULT_NSE_INDEX_ID;
  const [timeframe, setTimeframe] = useState('5m');
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0, current: '' });
  const [results, setResults] = useState([]);
  const [telemetry, setTelemetry] = useState(null);
  const [tokenError, setTokenError] = useState(null); // { broker } | null
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('actionable'); // 'all' | 'actionable'
  const [dirFilter, setDirFilter] = useState('any'); // 'any' | 'long' | 'short'
  const [searchQuery, setSearchQuery] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [lastScanAt, setLastScanAt] = useState(null);     // ms timestamp of last successful scan
  const [restoredFromCache, setRestoredFromCache] = useState(false); // true while showing persisted scan
  const [scanStartedAt, setScanStartedAt] = useState(null); // ms timestamp when scan began (for elapsed display)
  const [autoScan, setAutoScan] = useState(() => {
    try { return localStorage.getItem(AUTO_SCAN_KEY) === '1'; } catch { return false; }
  });
  const [tabVisible, setTabVisible] = useState(
    typeof document !== 'undefined' ? !document.hidden : true,
  );
  const abortRef = useRef(null);
  const autoScanTimerRef = useRef(null);

  const startScan = useCallback(async (token) => {
    setScanning(true);
    setRestoredFromCache(false);
    setScanStartedAt(Date.now());
    setError('');
    setResults([]);
    setTelemetry(null);
    setTokenError(null);
    setProgress({ completed: 0, total: 0, current: 'Loading index...' });
    resetBatchScanRateLimitState();

    try {
      // 1. Fetch constituents
      const symbols = await fetchNseIndexSymbolList(nseIndex);
      if (!symbols?.length) {
        setError('Could not load index constituents.');
        setScanning(false);
        return;
      }

      setProgress({ completed: 0, total: symbols.length, current: symbols[0] });

      // 2a. Compute index direction for scalp engine
      let indexDirection = null;
      if (engineVersion === 'scalp') {
        try { indexDirection = await getIndexDirection(nseIndex); } catch { /* ignore */ }
      }

      // 2b. Fetch live market context (VIX, FII/DII, Moneycontrol news).
      // All three layers run in parallel via CF Worker endpoints. Each
      // layer fails independently; missing data → null, which the
      // trade decision flow treats as "neutral / no veto / no bonus".
      // Scoped to this scan only — cached per-day in marketContextLive.
      let liveMarketContext = null;
      if (engineVersion === 'scalp') {
        try {
          const universe = new Set(symbols.map((s) => String(s).toUpperCase().replace(/\.NS$/, '')));
          liveMarketContext = await fetchLiveMarketContext(universe);
          // eslint-disable-next-line no-console
          console.log('[LiveContext]', {
            vix: liveMarketContext.vix,
            regime: liveMarketContext.vixRegime,
            fii: liveMarketContext.fii,
            dii: liveMarketContext.dii,
            flow: liveMarketContext.flow,
            newsCount: liveMarketContext.newsCount,
          });
        } catch {
          // Live context is optional — the scan runs fine without it.
        }
      }

      // 3. Run batch scan with engine-aware functions
      const controller = new AbortController();
      abortRef.current = controller;

      // High concurrency for both sources. Dhan does hit 429s sometimes, but
      // batchScan handles those with per-request retries (1s/2s/4s) — only
      // the failing call waits, the rest of the scan keeps moving. Lowering
      // concurrency to "avoid 429s" was the wrong fix because it serialized
      // the entire scan even on happy-path days.
      const scanResults = await batchScan({
        symbols,
        timeframe,
        gateToken: token,
        engineFns: getEngineFns(engineVersion),
        indexDirection,
        marketContext: liveMarketContext,
        concurrency: 8,
        delayMs: 0, // no fixed throttle — failed requests retry locally, others keep moving
        onProgress: (completed, total, current) => {
          setProgress({ completed, total, current });
        },
        onResult: (result) => {
          // Progressive rendering — show results as they arrive
          setResults(prev => {
            const next = [...prev, result];
            // Keep sorted: actionable first (by rank desc), then confidence desc
            next.sort((a, b) => {
              const ra = ACTION_RANK[a.action] || 0;
              const rb = ACTION_RANK[b.action] || 0;
              if (ra !== rb) return rb - ra;
              return b.confidence - a.confidence;
            });
            return next;
          });
        },
        signal: controller.signal,
        fetchFn: createFetchFn(dataSource || 'yahoo'),
        newsEnrichEnabled,
      });
      // Capture telemetry attached as a non-enumerable property on the result array
      if (scanResults && scanResults.telemetry) {
        setTelemetry({ ...scanResults.telemetry, dataSource: dataSource || 'yahoo', index: nseIndex, timeframe, engine: engineVersion });
      }
      // Surface broker token expiry as a reconnect banner. batchScan
      // short-circuits and attaches `tokenError` as a non-enumerable
      // property on the returned array (same convention as telemetry).
      if (scanResults && scanResults.tokenError) {
        setTokenError(scanResults.tokenError);
      }

      // ── Phase 5: Google News deep enrichment for top candidates ──
      // After the scan completes, pick the top-N actionable results and
      // fetch per-symbol Google News to deepen their sentiment signal.
      // This is phase 3's deep pass — Moneycontrol gave broad coverage;
      // Google gives per-stock depth for the ones we might actually trade.
      if (engineVersion === 'scalp' && liveMarketContext && scanResults.length > 0) {
        try {
          const topActionable = scanResults
            .filter((r) => r.action !== 'NO TRADE' && r.action !== 'WAIT')
            .slice(0, 10)
            .map((r) => r.symbol);
          if (topActionable.length > 0) {
            const enriched = await enrichWithGoogleNews(liveMarketContext.newsMap, topActionable);
            // eslint-disable-next-line no-console
            console.log(`[LiveContext] Google News enriched ${Object.keys(enriched).length - Object.keys(liveMarketContext.newsMap).length} new symbols`);
            // Note: the rankScore was already computed during the scan, so
            // the enriched scores affect only subsequent scans (which will
            // hit the cached map). For a live trader re-scanning every
            // few minutes, this means the second scan has the benefit.
            liveMarketContext.newsMap = enriched;
          }
        } catch {
          // Enrichment is optional — scan results are already shown
        }
      }
    } catch (e) {
      const msg = e?.message || String(e);
      if (msg.includes('403')) {
        clearGateToken();
        setError('Invalid passphrase. Please try again.');
      } else if (e?.name !== 'AbortError') {
        setError(msg);
      }
    } finally {
      setScanning(false);
      setScanStartedAt(null);
      abortRef.current = null;
      // Mark scan completion + persist results so a refresh / accidental nav
      // doesn't force the user to rerun. We snapshot from state inside the
      // setter callback to avoid stale closures.
      setLastScanAt(Date.now());
      setResults((latestResults) => {
        if (latestResults.length > 0) {
          setTelemetry((latestTelem) => {
            saveScanResults({
              engine: engineVersion,
              index: nseIndex,
              timeframe,
              dataSource: dataSource || 'yahoo',
              results: latestResults,
              telemetry: latestTelem,
              savedAt: Date.now(),
            });
            return latestTelem;
          });
        }
        return latestResults;
      });
    }
  }, [nseIndex, timeframe, engineVersion, dataSource, newsEnrichEnabled]);

  const handleScanClick = useCallback(() => {
    if (scanning) {
      // Cancel
      abortRef.current?.abort();
      return;
    }

    if (!hasGateToken()) {
      setShowPassphrase(true);
      return;
    }

    startScan(getGateToken());
  }, [scanning, startScan]);

  // Restore the most recent persisted scan when the user lands on the page
  // for a (engine, index, timeframe, dataSource) tuple they've scanned before.
  // This is a paper-cut fix: previously a refresh after a 30s/300-stock scan
  // forced the user to rerun the whole thing.
  useEffect(() => {
    // Don't clobber an in-flight or fresh scan.
    if (scanning) return;
    if (results.length > 0 && !restoredFromCache) return;
    const cached = loadScanResults({
      engine: engineVersion,
      index: nseIndex,
      timeframe,
      dataSource: dataSource || 'yahoo',
    });
    if (cached && cached.results?.length > 0) {
      setResults(cached.results);
      setTelemetry(cached.telemetry || null);
      setLastScanAt(cached.savedAt || null);
      setRestoredFromCache(true);
    } else {
      // Switching engine/index/timeframe to a tuple we have no cache for —
      // wipe the previously-restored view so the empty state shows fresh.
      if (restoredFromCache) {
        setResults([]);
        setTelemetry(null);
        setLastScanAt(null);
        setRestoredFromCache(false);
      }
    }
    // Intentionally narrow deps: we only re-evaluate on key change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineVersion, nseIndex, timeframe, dataSource]);

  // Track tab visibility so the auto-scan loop pauses when the app is
  // backgrounded — saves API quota and prevents stale-data races on resume.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVis = () => setTabVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Auto-scan loop. Computes the next-fire delay from scanScheduler and
  // arms a single setTimeout. Re-runs whenever any input changes (engine,
  // toggle, market state, visibility, scan completion) so it self-corrects
  // when conditions shift. clearTimeout in cleanup is essential — without it
  // a toggle-off mid-wait would still fire one stray scan.
  useEffect(() => {
    if (autoScanTimerRef.current) {
      clearTimeout(autoScanTimerRef.current);
      autoScanTimerRef.current = null;
    }
    if (!autoScan) return;
    if (!hasGateToken()) return;
    const market = getMarketStatus();
    const decision = decideNextScan({
      engine: engineVersion,
      timeframe,
      now: Date.now(),
      lastScanAt,
      marketIsOpen: market.isOpen,
      tabVisible,
      scanInFlight: scanning,
      hasBlockingError: Boolean(tokenError) || Boolean(error),
    });
    if (decision.action === 'idle') return;
    autoScanTimerRef.current = setTimeout(() => {
      autoScanTimerRef.current = null;
      // Re-check conditions at fire time — state may have shifted while waiting.
      if (!hasGateToken()) return;
      if (scanning) return;
      const m2 = getMarketStatus();
      if (!m2.isOpen) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      startScan(getGateToken());
    }, decision.delayMs);
    return () => {
      if (autoScanTimerRef.current) {
        clearTimeout(autoScanTimerRef.current);
        autoScanTimerRef.current = null;
      }
    };
  }, [autoScan, engineVersion, timeframe, lastScanAt, tabVisible, scanning, tokenError, error, startScan]);

  // Persist the auto-scan toggle so the preference survives page reloads.
  useEffect(() => {
    try { localStorage.setItem(AUTO_SCAN_KEY, autoScan ? '1' : '0'); } catch { /* ignore */ }
  }, [autoScan]);

  const handlePassphraseSubmit = useCallback(async (passphrase) => {
    // unlockGate stores both the hash (gate token) AND the RSA public key,
    // so downstream flows like Dhan auth can encrypt credentials without
    // needing a second passphrase entry.
    await unlockGate(passphrase);
    setShowPassphrase(false);
    startScan(getGateToken()); // read the stored hash, not the plaintext
  }, [startScan]);

  const sq = searchQuery.trim().toUpperCase();
  // Expired signals remain visible in the Actionable filter — they're still
  // valid trade ideas that fired, just past their entry window. The card
  // renders an EXPIRED badge so the user knows not to chase the entry, but
  // can still drill in to see the chart and what happened.
  const displayed = results.filter((r) => {
    if (filter === 'actionable' && (r.action === 'NO TRADE' || r.action === 'WAIT')) return false;
    if (dirFilter === 'long' && r.direction !== 'long') return false;
    if (dirFilter === 'short' && r.direction !== 'short') return false;
    if (sq && !r.symbol.includes(sq) && !(r.companyName || '').toUpperCase().includes(sq)) return false;
    return true;
  });

  const pct = progress.total > 0 ? (progress.completed / progress.total) * 100 : 0;

  return (
    <div>
      {showPassphrase && (
        <PassphraseModal
          onSubmit={handlePassphraseSubmit}
          onCancel={() => setShowPassphrase(false)}
        />
      )}

      {/* Index selector */}
      <div style={{ marginBottom: 10 }}>
        <select
          value={nseIndex}
          onChange={(e) => onIndexChange(e.target.value)}
          disabled={scanning}
          style={{
            width: '100%', padding: '10px 12px', fontSize: 13, fontWeight: 600,
            borderRadius: 8, border: '1px solid #e2e5eb', background: '#fff',
            color: '#1a1d26', cursor: scanning ? 'not-allowed' : 'pointer',
          }}
        >
          {allOptions.slice(0, NSE_INDEX_OPTIONS.length).map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
          {allOptions.length > NSE_INDEX_OPTIONS.length && (
            <optgroup label="Custom">
              {allOptions.slice(NSE_INDEX_OPTIONS.length).map((o) => (
                <option key={o.id} value={o.id}>{o.id}</option>
              ))}
            </optgroup>
          )}
        </select>
      </div>

      {/* Timeframe pills */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 12 }}>
        {ALL_TFS.map((tf) => (
          <button
            key={tf}
            type="button"
            disabled={scanning}
            onClick={() => setTimeframe(tf)}
            style={{
              minHeight: 32, padding: '0 10px', fontSize: 12, fontWeight: 600,
              borderRadius: 999,
              border: timeframe === tf ? 'none' : '1px solid #e2e5eb',
              background: timeframe === tf ? '#2563eb' : '#fff',
              color: timeframe === tf ? '#fff' : '#4a5068',
              cursor: scanning ? 'not-allowed' : 'pointer',
              opacity: scanning ? 0.5 : 1,
            }}
          >
            {tf}
          </button>
        ))}
      </div>

      {/* Scan button */}
      <button
        type="button"
        onClick={handleScanClick}
        style={{
          width: '100%', padding: '12px 0', fontSize: 14, fontWeight: 700,
          borderRadius: 10, border: 'none', cursor: 'pointer',
          background: scanning ? '#dc2626' : '#2563eb',
          color: '#fff', marginBottom: 8,
        }}
      >
        {scanning
          ? `Cancel (${progress.completed}/${progress.total})`
          : 'Scan All'}
      </button>

      {/* Auto-scan toggle. Disabled (and visually muted) when the engine
          doesn't support auto-scan (delivery) so the user isn't misled. */}
      <AutoScanRow
        engine={engineVersion}
        timeframe={timeframe}
        autoScan={autoScan}
        setAutoScan={setAutoScan}
        scanning={scanning}
        lastScanAt={lastScanAt}
      />

      {/* Cached-results banner — shown when we restored from localStorage
          so the user knows what they're looking at isn't this minute's data. */}
      {restoredFromCache && lastScanAt && !scanning && (
        <div style={{
          padding: '8px 10px', borderRadius: 8,
          background: '#fffbeb', border: '1px solid #fde68a',
          color: '#92400e', fontSize: 11, marginBottom: 10,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ flex: 1 }}>
            Showing saved results from {formatIstTime(Math.floor(lastScanAt / 1000))} —
            tap <strong>Scan All</strong> to refresh.
          </span>
          <button
            type="button"
            onClick={() => {
              clearScanResults({
                engine: engineVersion,
                index: nseIndex,
                timeframe,
                dataSource: dataSource || 'yahoo',
              });
              setResults([]);
              setTelemetry(null);
              setLastScanAt(null);
              setRestoredFromCache(false);
            }}
            style={{
              padding: '3px 8px', fontSize: 10, fontWeight: 600,
              borderRadius: 6, border: '1px solid #fde68a',
              background: '#fff', color: '#92400e', cursor: 'pointer',
            }}
          >
            Clear
          </button>
        </div>
      )}

      {/* Progress bar */}
      {scanning && (
        <div style={{ marginBottom: 12 }}>
          <div style={{
            height: 6, borderRadius: 3, background: '#e2e5eb', overflow: 'hidden',
            marginBottom: 4,
          }}>
            <div style={{
              height: '100%', width: `${pct}%`, background: '#2563eb',
              borderRadius: 3, transition: 'width 0.3s',
            }} />
          </div>
          <div style={{ fontSize: 11, color: '#8892a8' }}>
            Scanning {progress.current}...
            {scanStartedAt && (
              <span style={{ marginLeft: 6, fontFamily: mono, color: '#4a5068' }}>
                <ScanElapsed startedAt={scanStartedAt} />
              </span>
            )}
          </div>
        </div>
      )}

      {/* Broker token expiry — takes priority over generic scan errors
          since the user can't do anything until they reconnect. */}
      {tokenError && (
        <TokenExpiryBanner broker={tokenError.broker} onOpenSettings={onOpenSettings} />
      )}

      {/* Error */}
      {error && (
        <div style={{
          padding: 12, borderRadius: 10, background: '#fef2f2', border: '1px solid #fecaca',
          color: '#991b1b', fontSize: 13, marginBottom: 12, lineHeight: 1.4,
        }}>
          {error}
        </div>
      )}

      {/* Telemetry — visible to all users (compact summary) */}
      {telemetry && (
        <div style={{
          padding: '8px 10px', borderRadius: 8, background: '#f0f4ff', border: '1px solid #dbeafe',
          marginBottom: 10, fontSize: 11, color: '#4a5068',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: mono, fontWeight: 700, color: '#2563eb' }}>
              {(telemetry.totalMs / 1000).toFixed(1)}s
            </span>
            <span>·</span>
            <span><strong>{telemetry.symbolsScanned}</strong>/{telemetry.symbolsRequested} scanned</span>
            <span>·</span>
            <span><strong>{telemetry.symbolsActionable}</strong> actionable</span>
            {telemetry.rateLimitHits > 0 && (
              <>
                <span>·</span>
                <span style={{ color: '#d97706' }}>
                  {telemetry.rateLimitHits} 429s ({telemetry.retriesRecovered} recovered{telemetry.retriesFailed > 0 ? `, ${telemetry.retriesFailed} failed` : ''})
                </span>
              </>
            )}
            {telemetry.fetchErrors > 0 && (
              <>
                <span>·</span>
                <span style={{ color: '#dc2626' }}>{telemetry.fetchErrors} errors</span>
              </>
            )}
            {debugMode && (
              <button
                type="button"
                onClick={async () => {
                  const report = {
                    generatedAt: new Date().toISOString(),
                    telemetry,
                    sample: results.slice(0, 5).map((r) => ({
                      symbol: r.symbol, action: r.action, confidence: r.confidence,
                      direction: r.direction, entry: r.entry, sl: r.sl, target: r.target,
                      pattern: r.topPattern, signalBarTs: r.signalBarTs, validTillTs: r.validTillTs,
                    })),
                    counts: {
                      total: results.length,
                      actionable: results.filter((r) => r.action !== 'NO TRADE' && r.action !== 'WAIT').length,
                      strongBuy: results.filter((r) => r.action === 'STRONG BUY').length,
                      buy: results.filter((r) => r.action === 'BUY').length,
                      strongShort: results.filter((r) => r.action === 'STRONG SHORT').length,
                      short: results.filter((r) => r.action === 'SHORT').length,
                      wait: results.filter((r) => r.action === 'WAIT').length,
                      noTrade: results.filter((r) => r.action === 'NO TRADE').length,
                    },
                  };
                  const text = JSON.stringify(report, null, 2);
                  try {
                    await navigator.clipboard.writeText(text);
                    setCopyStatus('Copied');
                  } catch {
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    ta.style.position = 'fixed';
                    ta.style.left = '-9999px';
                    document.body.appendChild(ta);
                    ta.select();
                    try { document.execCommand('copy'); setCopyStatus('Copied'); }
                    catch { setCopyStatus('Failed'); /* eslint-disable-next-line no-console */ console.log(text); }
                    document.body.removeChild(ta);
                  }
                  setTimeout(() => setCopyStatus(''), 2500);
                }}
                style={{
                  marginLeft: 'auto', padding: '3px 8px', fontSize: 10, fontWeight: 600,
                  borderRadius: 5, border: '1px solid #dbeafe',
                  background: copyStatus ? '#f0fdf4' : '#fff',
                  color: copyStatus ? '#16a34a' : '#4a5068',
                  cursor: 'pointer',
                }}
              >
                {copyStatus || '📋 Copy Debug'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <>
          {/* Filter pills */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap',
          }}>
            {[
              { key: 'actionable', label: 'Actionable' },
              { key: 'all', label: 'All' },
            ].map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                style={{
                  fontSize: 11, fontWeight: 600, padding: '5px 12px', borderRadius: 999,
                  border: filter === f.key ? 'none' : '1px solid #e2e5eb',
                  background: filter === f.key ? '#2563eb' : '#fff',
                  color: filter === f.key ? '#fff' : '#4a5068',
                  cursor: 'pointer',
                }}
              >
                {f.label}
              </button>
            ))}
            <span style={{ width: 1, height: 18, background: '#e2e5eb', margin: '0 2px' }} />
            {[
              { key: 'any', label: 'Any' },
              { key: 'long', label: 'Buy', color: '#16a34a' },
              { key: 'short', label: 'Short', color: '#dc2626' },
            ].map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setDirFilter(f.key)}
                style={{
                  fontSize: 11, fontWeight: 600, padding: '5px 12px', borderRadius: 999,
                  border: dirFilter === f.key ? 'none' : '1px solid #e2e5eb',
                  background: dirFilter === f.key ? (f.color || '#2563eb') : '#fff',
                  color: dirFilter === f.key ? '#fff' : '#4a5068',
                  cursor: 'pointer',
                }}
              >
                {f.label}
              </button>
            ))}
            <span style={{ fontSize: 11, color: '#8892a8', marginLeft: 4 }}>
              {displayed.length} of {results.length}
            </span>
          </div>

          {/* Quick search */}
          <div style={{ position: 'relative', marginBottom: 10 }}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search stock..."
              style={{
                width: '100%', padding: '8px 12px 8px 32px', fontSize: 13,
                borderRadius: 8, border: '1px solid #e2e5eb', background: '#fff',
                outline: 'none', boxSizing: 'border-box', color: '#1a1d26',
              }}
            />
            <span style={{
              position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
              fontSize: 14, color: '#8892a8', pointerEvents: 'none',
            }}>
              &#x1F50D;
            </span>
          </div>

          {/* Result cards */}
          <div>
            {displayed.map((r) => (
              <ResultCard
                key={r.symbol}
                r={r}
                scheduledChecks={scheduledChecks}
                onTap={(sym) => {
                  onSelectSymbol(sym);
                }}
              />
            ))}
          </div>

          {displayed.length === 0 && (
            <div style={{
              textAlign: 'center', padding: 24, color: '#8892a8', fontSize: 13,
              display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center',
            }}>
              <div>No matches for the current filters.</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
                {filter !== 'all' && (
                  <button
                    type="button"
                    onClick={() => setFilter('all')}
                    style={{
                      fontSize: 11, fontWeight: 600, padding: '4px 10px',
                      borderRadius: 999, border: '1px solid #e2e5eb',
                      background: '#fff', color: '#2563eb', cursor: 'pointer',
                    }}
                  >
                    Show all results
                  </button>
                )}
                {dirFilter !== 'any' && (
                  <button
                    type="button"
                    onClick={() => setDirFilter('any')}
                    style={{
                      fontSize: 11, fontWeight: 600, padding: '4px 10px',
                      borderRadius: 999, border: '1px solid #e2e5eb',
                      background: '#fff', color: '#2563eb', cursor: 'pointer',
                    }}
                  >
                    Clear direction filter
                  </button>
                )}
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    style={{
                      fontSize: 11, fontWeight: 600, padding: '4px 10px',
                      borderRadius: 999, border: '1px solid #e2e5eb',
                      background: '#fff', color: '#2563eb', cursor: 'pointer',
                    }}
                  >
                    Clear search "{searchQuery}"
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {!scanning && results.length === 0 && !error && (
        <div style={{
          textAlign: 'center', padding: '40px 20px', color: '#8892a8',
        }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>&#x1F50D;</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Index Scanner</div>
          <div style={{ fontSize: 12, lineHeight: 1.5 }}>
            Scan all stocks in an index to find the strongest intraday signals.
            Select an index and timeframe, then tap "Scan All".
          </div>
        </div>
      )}
    </div>
  );
}
