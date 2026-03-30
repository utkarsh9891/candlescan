/** Signal category keys for filters, stats, and pattern engines. */

/** Intraday categories (Classic + Enhanced engines). */
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

/** Get categories for a given engine version. */
export function getCategoriesForEngine(engineVersion) {
  return engineVersion === 'scalp' ? SCALP_CATEGORIES : SIGNAL_CATEGORIES;
}

/** Approximate discrete rules per engine. */
export const APPROX_PATTERN_RULES = 46;
export const APPROX_SCALP_RULES = 14;

export function getRuleCountForEngine(engineVersion) {
  return engineVersion === 'scalp' ? APPROX_SCALP_RULES : APPROX_PATTERN_RULES;
}
