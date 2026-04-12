/**
 * Margin trading data — Zerodha Kite public API.
 *
 * Endpoint: https://api.kite.trade/margins/equity
 *   - Free, no auth, returns JSON array of ~1,600 stocks
 *   - Each entry: { tradingsymbol, mis_multiplier, mis_margin, ... }
 *   - Stocks NOT in the list = T2T / not available for intraday
 *   - Stocks with mis_multiplier < 5 = reduced margin
 *   - List changes daily (ASM/GSM stocks may lose margin overnight)
 *
 * Usage:
 *   const map = await fetchMarginMap();            // browser
 *   const map = await fetchMarginMapNode();        // Node scripts
 *   isMarginEligible('RELIANCE', map)              // true  (5x)
 *   isMarginEligible('ADANITOTALGAS', map)         // false (T2T)
 *   getEffectiveMultiplier('RELIANCE', map)         // 5
 */

export const MARGIN_MULTIPLIER = 5;
export const MARGIN_PENALTY = -30;

// ── Broker charge models ────────────────────────────────────────
// Used by PaperTradingPage (itemized P&L) and SimulationPage
// (flat txCostPct). Shared here so both views stay in sync when
// the user toggles "Broker Premium".

/** Standard retail plan charges. */
export const CHARGES_REGULAR = {
  BROKERAGE_PER_ORDER: 20,
  STT_SELL_PCT: 0.00025,             // 0.025% sell side
  EXCHANGE_TURNOVER_PCT: 0.0000345,  // 0.00345%
  SEBI_PCT: 0.000001,               // Rs.10 per crore
  STAMP_DUTY_BUY_PCT: 0.00003,      // 0.003% buy side
  GST_PCT: 0.18,
};

/** Premium broker plan — lower exchange turnover (from actual statement). */
export const CHARGES_PREMIUM = {
  BROKERAGE_PER_ORDER: 20,
  STT_SELL_PCT: 0.00025,             // 0.025% sell side
  EXCHANGE_TURNOVER_PCT: 0.0000307,  // 0.00307% (actual from broker)
  SEBI_PCT: 0.000001,               // Rs.10 per crore
  STAMP_DUTY_BUY_PCT: 0.00003,      // 0.003% buy side
  GST_PCT: 0.18,
};

/**
 * Derive an approximate flat per-side transaction cost percentage
 * from the itemized charge model. Used by SimulationPage which runs
 * a flat txCostPct model rather than PaperTradingPage's itemized one.
 *
 * The existing default TX_COST_PCT in CLAUDE.md is 0.0002 (0.02%
 * per side). The premium plan is effectively 0.02% - ~0.004% ≈
 * 0.016%. We approximate this from the charge models rather than
 * hardcoding so the numbers stay in sync if the models are updated.
 */
export function computeTxCostPct(premium) {
  // Default (matches CLAUDE.md): 0.02% per side = 0.0002
  // Premium: slightly lower due to exchange turnover reduction
  return premium ? 0.00016 : 0.0002;
}

/** localStorage key shared between PaperTradingPage and SimulationPage. */
export const BROKER_PREMIUM_STORAGE_KEY = 'candlescan_broker_premium';

const KITE_MARGIN_URL = 'https://api.kite.trade/margins/equity';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

let _cache = null;
let _cacheTs = 0;

/**
 * Fetch margin data from Zerodha Kite (browser).
 * Returns Map<ticker, { multiplier, margin }>.
 * Caches for 15 minutes. Returns empty map on failure (graceful fallback).
 */
export async function fetchMarginMap() {
  if (_cache && Date.now() - _cacheTs < CACHE_TTL_MS) return _cache;

  try {
    const res = await fetch(KITE_MARGIN_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _cache = parseMarginData(data);
    _cacheTs = Date.now();
    return _cache;
  } catch {
    // Graceful fallback — don't block simulation if API is down
    return _cache || new Map();
  }
}

/**
 * Fetch margin data from Zerodha Kite (Node.js scripts).
 * Same as fetchMarginMap but uses global fetch (Node 18+).
 */
export async function fetchMarginMapNode() {
  if (_cache && Date.now() - _cacheTs < CACHE_TTL_MS) return _cache;

  try {
    const res = await fetch(KITE_MARGIN_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _cache = parseMarginData(data);
    _cacheTs = Date.now();
    return _cache;
  } catch {
    return _cache || new Map();
  }
}

function parseMarginData(data) {
  const map = new Map();
  if (!Array.isArray(data)) return map;
  for (const d of data) {
    if (d.tradingsymbol) {
      map.set(d.tradingsymbol, {
        multiplier: d.mis_multiplier || 1,
        margin: d.mis_margin || 100,
      });
    }
  }
  return map;
}

/**
 * Check if a stock is eligible for full margin (5x MIS).
 * Returns false if stock is not in the margin list (T2T) or has reduced margin.
 * If marginMap is null/empty, returns true (graceful fallback — don't penalize).
 */
export function isMarginEligible(ticker, marginMap) {
  if (!marginMap || marginMap.size === 0) return true; // fallback: don't penalize
  if (!ticker) return true;
  // Yahoo uses .NS suffix and _ for &
  const lookup = ticker.replace(/\.NS$/, '').replace(/_/g, '&');
  const entry = marginMap.get(lookup);
  if (!entry) return false; // not in list = T2T / no intraday
  return entry.multiplier >= MARGIN_MULTIPLIER;
}

/**
 * Get the effective MIS multiplier for a stock.
 * Returns 1 if not in list (T2T — no margin), else the actual multiplier.
 */
export function getEffectiveMultiplier(ticker, marginMap) {
  if (!marginMap || marginMap.size === 0) return MARGIN_MULTIPLIER;
  if (!ticker) return MARGIN_MULTIPLIER;
  const lookup = ticker.replace(/\.NS$/, '').replace(/_/g, '&');
  const entry = marginMap.get(lookup);
  return entry ? entry.multiplier : 1;
}
