/**
 * scanScheduler — pure logic for "when should the next auto-scan fire?"
 *
 * Replaces the manual click-to-scan ritual with a hands-free loop that
 * fires on engine-appropriate cadences during market hours and pauses
 * everywhere else (tab hidden, market closed, scan in flight, error).
 *
 * Cadence policy (cadenceMs):
 *   scalp     1m timeframe → 60s
 *   intraday  5m            → 300s (aligned to bar close, best-effort)
 *   intraday  15m           → 900s
 *   intraday  other         → 300s (default to 5m cadence)
 *   delivery  1d            → null (no auto-rescan; daily is too slow to matter)
 *
 * The scheduler is a pure function — UI wires it into a setInterval/setTimeout
 * loop and feeds it `now`, `lastScanAt`, market state, and visibility. Returning
 * a delay (>= 0 ms) means "fire after this much time"; returning null means
 * "don't auto-scan in current state". This separation makes it trivial to test.
 */

const ONE_MIN = 60 * 1000;
const FIVE_MIN = 5 * ONE_MIN;
const FIFTEEN_MIN = 15 * ONE_MIN;

const ENGINE_CADENCE = {
  scalp: { '1m': ONE_MIN, '5m': FIVE_MIN, default: ONE_MIN },
  intraday: { '5m': FIVE_MIN, '15m': FIFTEEN_MIN, default: FIVE_MIN },
  delivery: null,
};

/**
 * Returns the auto-scan cadence in ms for a given engine + timeframe,
 * or null if auto-scan should be disabled for that combo.
 */
export function getCadenceMs(engine, timeframe) {
  const e = ENGINE_CADENCE[engine];
  if (!e) return null;
  return e[timeframe] || e.default;
}

/**
 * Decide what to do next.
 *
 * Inputs:
 *   - engine, timeframe   → drives cadence
 *   - now                 → current ms
 *   - lastScanAt          → ms when last successful scan completed (null = never)
 *   - marketIsOpen        → bool, from getMarketStatus()
 *   - tabVisible          → bool, from !document.hidden
 *   - scanInFlight        → bool, true if a scan is currently running
 *   - hasBlockingError    → bool, true if token expiry / passphrase missing / etc.
 *
 * Returns:
 *   { action: 'fire',    delayMs: 0 }   — fire immediately
 *   { action: 'wait',    delayMs: N }   — fire in N ms (caller should setTimeout)
 *   { action: 'idle',    reason: '...' } — don't auto-scan; reason is human-readable
 */
export function decideNextScan({
  engine,
  timeframe,
  now,
  lastScanAt,
  marketIsOpen,
  tabVisible,
  scanInFlight,
  hasBlockingError,
}) {
  if (scanInFlight) return { action: 'idle', reason: 'scan-in-flight' };
  if (hasBlockingError) return { action: 'idle', reason: 'blocking-error' };
  if (!tabVisible) return { action: 'idle', reason: 'tab-hidden' };
  if (!marketIsOpen) return { action: 'idle', reason: 'market-closed' };

  const cadence = getCadenceMs(engine, timeframe);
  if (cadence == null) return { action: 'idle', reason: 'engine-disabled' };

  // First auto-scan after enabling: don't fire immediately if user just
  // ran a manual scan. Wait one full cadence from the last scan completion,
  // or fire now if there's no prior scan in this session.
  if (lastScanAt == null) return { action: 'fire', delayMs: 0 };

  const elapsed = now - lastScanAt;
  if (elapsed >= cadence) return { action: 'fire', delayMs: 0 };

  return { action: 'wait', delayMs: cadence - elapsed };
}

/**
 * Convenience wrapper for setTimeout-based loops.
 * Returns the timer handle (for clearTimeout) plus the decision.
 *
 * Caller is responsible for calling `runScan()` when action === 'fire'.
 * Re-invoke `scheduleNext` each time a scan completes / state changes.
 */
export function scheduleNext({
  state,
  onFire,
  setTimeoutFn = setTimeout,
}) {
  const decision = decideNextScan({ ...state, now: Date.now() });
  if (decision.action === 'fire') {
    // Fire on next tick so callers get a stable async boundary.
    const handle = setTimeoutFn(() => onFire(), 0);
    return { handle, decision };
  }
  if (decision.action === 'wait') {
    const handle = setTimeoutFn(() => onFire(), decision.delayMs);
    return { handle, decision };
  }
  return { handle: null, decision };
}

/**
 * Format a cadence as a short human label for UI ("60s", "5m", "15m").
 */
export function cadenceLabel(engine, timeframe) {
  const ms = getCadenceMs(engine, timeframe);
  if (ms == null) return 'manual only';
  if (ms < ONE_MIN) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * ONE_MIN) return `${Math.round(ms / ONE_MIN)}m`;
  return `${Math.round(ms / (60 * ONE_MIN))}h`;
}
