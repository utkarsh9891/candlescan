/**
 * Scalp variant registry.
 * Maps variant keys to their engine functions + UI metadata.
 *
 * Usage:
 *   import { getScalpVariantFns, SCALP_VARIANTS } from './registry.js';
 *   const fns = getScalpVariantFns('boxTheory');
 *   // → { detectPatterns, detectLiquidityBox, computeRiskScore }
 */

// Momentum (current/original) — import from parent engine files
import { detectPatterns as momentumPatterns } from '../patterns-scalp.js';
import { detectLiquidityBox as momentumBox } from '../liquidityBox-scalp.js';
import { computeRiskScore as momentumRisk } from '../risk-scalp.js';

// Transcript-based variants
import { detectPatterns as boxPatterns, detectLiquidityBox as boxBox, computeRiskScore as boxRisk } from './boxTheory.js';
import { detectPatterns as qfPatterns, detectLiquidityBox as qfBox, computeRiskScore as qfRisk } from './quickFlip.js';
import { detectPatterns as fhrPatterns, detectLiquidityBox as fhrBox, computeRiskScore as fhrRisk } from './fourHourRange.js';
import { detectPatterns as tatPatterns, detectLiquidityBox as tatBox, computeRiskScore as tatRisk } from './touchAndTurn.js';
import { detectPatterns as fusionPatterns, detectLiquidityBox as fusionBox, computeRiskScore as fusionRisk } from './fusion.js';

/**
 * Variant metadata for UI rendering.
 */
export const SCALP_VARIANTS = [
  { key: 'momentum',     label: 'Momentum',     color: '#d97706', description: 'Original — VWAP/ORB/breakout momentum patterns' },
  { key: 'boxTheory',    label: 'Box Theory',    color: '#8b5cf6', description: 'Prev day high/low range — fade the extremes' },
  { key: 'quickFlip',    label: 'Quick Flip',    color: '#06b6d4', description: 'ORB + liquidity candle → reversal candlestick outside range' },
  { key: 'fourHourRange', label: '4H Range',     color: '#10b981', description: '4-hour candle range — breakout + reentry reversal' },
  { key: 'touchAndTurn', label: 'Touch & Turn',  color: '#f43f5e', description: 'ORB + Fibonacci — limit order at range edge' },
  { key: 'fusion',       label: 'Fusion',        color: '#6366f1', description: 'Amalgamation — ≥2 strategies must agree' },
];

const VARIANT_FNS = {
  momentum:      { detectPatterns: momentumPatterns, detectLiquidityBox: momentumBox, computeRiskScore: momentumRisk },
  boxTheory:     { detectPatterns: boxPatterns,      detectLiquidityBox: boxBox,      computeRiskScore: boxRisk },
  quickFlip:     { detectPatterns: qfPatterns,       detectLiquidityBox: qfBox,       computeRiskScore: qfRisk },
  fourHourRange: { detectPatterns: fhrPatterns,      detectLiquidityBox: fhrBox,      computeRiskScore: fhrRisk },
  touchAndTurn:  { detectPatterns: tatPatterns,      detectLiquidityBox: tatBox,      computeRiskScore: tatRisk },
  fusion:        { detectPatterns: fusionPatterns,    detectLiquidityBox: fusionBox,   computeRiskScore: fusionRisk },
};

/**
 * Get engine functions for a scalp variant.
 * @param {string} variantKey — one of SCALP_VARIANTS keys
 * @returns {{ detectPatterns, detectLiquidityBox, computeRiskScore }}
 */
export function getScalpVariantFns(variantKey) {
  return VARIANT_FNS[variantKey] || VARIANT_FNS.momentum;
}

/** Default variant key. */
export const DEFAULT_SCALP_VARIANT = 'momentum';
