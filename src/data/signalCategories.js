/** Signal category keys for filters, stats, and pattern engines. */

/** Intraday categories (Enhanced engine). */
export const SIGNAL_CATEGORIES = [
  'engulfing',
  'piercing',
  'hammer',
  'reversal',
  'pullback',
  'liquidity',
  'momentum',
  'indecision',
];

/** Scalping categories (Scalp engine). */
export const SCALP_CATEGORIES = [
  'vwap',
  'orb',
  'micro-momentum',
  'ema-cross',
  'volume-climax',
  'prev-day',
  'micro-double',
];

/** Classic (Swing) categories. */
export const CLASSIC_CATEGORIES = [
  'ma-cross',
  'support-resistance',
  'channel',
  'volume-surge',
  'swing-structure',
  'daily-engulfing',
  'gap',
];

/**
 * Canonical engine codes (v0.17+):
 *   - 'scalp'    → 1m, ≤20-min holds
 *   - 'intraday' → 5m or 15m, full-session same-day (was 'v2')
 *   - 'delivery' → daily, multi-day positions (was 'v1' / 'classic')
 *
 * Legacy 'v1', 'v2', 'classic' codes are accepted as input (back-compat
 * for stored localStorage values + CLI flags) and normalized. All
 * engine === '<x>' conditionals must use canonical names — pass any
 * external value through normalizeEngine() at the boundary.
 */
export const ENGINE_LIST = ['scalp', 'intraday', 'delivery'];

export function normalizeEngine(v) {
  if (v === 'v2') return 'intraday';
  if (v === 'v1' || v === 'classic') return 'delivery';
  if (ENGINE_LIST.includes(v)) return v;
  return 'scalp';
}

/** Get categories for a given engine version. */
export function getCategoriesForEngine(engineVersion) {
  const e = normalizeEngine(engineVersion);
  if (e === 'scalp') return SCALP_CATEGORIES;
  if (e === 'delivery') return CLASSIC_CATEGORIES;
  return SIGNAL_CATEGORIES;
}

/** UI-friendly `{ key, label }` list for each engine — used by filter pills. */
const INTRADAY_CATEGORIES_UI = [
  { key: 'engulfing', label: 'Engulfing' },
  { key: 'piercing', label: 'Piercing' },
  { key: 'hammer', label: 'Hammer' },
  { key: 'reversal', label: 'Reversal' },
  { key: 'pullback', label: 'Pullback' },
  { key: 'liquidity', label: 'Liquidity' },
  { key: 'momentum', label: 'Momentum' },
  { key: 'indecision', label: 'Indecision' },
];

const SCALP_CATEGORIES_UI = [
  { key: 'vwap', label: 'VWAP' },
  { key: 'orb', label: 'ORB' },
  { key: 'micro-momentum', label: 'Momentum' },
  { key: 'ema-cross', label: 'EMA Cross' },
  { key: 'volume-climax', label: 'Vol Climax' },
  { key: 'prev-day', label: 'Prev Day' },
  { key: 'micro-double', label: 'Double B/T' },
];

const CLASSIC_CATEGORIES_UI = [
  { key: 'ma-cross', label: 'MA Cross' },
  { key: 'support-resistance', label: 'Support/Resist' },
  { key: 'channel', label: 'Channel' },
  { key: 'volume-surge', label: 'Vol Surge' },
  { key: 'swing-structure', label: 'Swing Struct' },
  { key: 'daily-engulfing', label: 'Engulfing' },
  { key: 'gap', label: 'Gap' },
];

export function getCategoriesUIForEngine(engineVersion) {
  const e = normalizeEngine(engineVersion);
  if (e === 'scalp') return SCALP_CATEGORIES_UI;
  if (e === 'delivery') return CLASSIC_CATEGORIES_UI;
  return INTRADAY_CATEGORIES_UI;
}

/** Approximate discrete rules per engine. */
export const APPROX_PATTERN_RULES = 46;
export const APPROX_SCALP_RULES = 14;
export const APPROX_CLASSIC_RULES = 14;

export function getRuleCountForEngine(engineVersion) {
  const e = normalizeEngine(engineVersion);
  if (e === 'scalp') return APPROX_SCALP_RULES;
  if (e === 'delivery') return APPROX_CLASSIC_RULES;
  return APPROX_PATTERN_RULES;
}
