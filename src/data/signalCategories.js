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

/** Get categories for a given engine version. */
export function getCategoriesForEngine(engineVersion) {
  if (engineVersion === 'scalp') return SCALP_CATEGORIES;
  if (engineVersion === 'v1') return CLASSIC_CATEGORIES;
  return SIGNAL_CATEGORIES;
}

/** Approximate discrete rules per engine. */
export const APPROX_PATTERN_RULES = 46;
export const APPROX_SCALP_RULES = 14;
export const APPROX_CLASSIC_RULES = 14;

export function getRuleCountForEngine(engineVersion) {
  if (engineVersion === 'scalp') return APPROX_SCALP_RULES;
  if (engineVersion === 'v1') return APPROX_CLASSIC_RULES;
  return APPROX_PATTERN_RULES;
}
