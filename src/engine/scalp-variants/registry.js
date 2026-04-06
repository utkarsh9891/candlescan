/**
 * Scalp variant registry.
 * Maps variant keys to their engine functions + UI metadata.
 */

// Momentum (current/original) — import from parent engine files
import { detectPatterns as momentumPatterns } from '../patterns-scalp.js';
import { detectLiquidityBox as momentumBox } from '../liquidityBox-scalp.js';
import { computeRiskScore as momentumRisk } from '../risk-scalp.js';

// Fusion (consensus of rule-based strategies — imports boxTheory/quickFlip/touchAndTurn internally)
import { detectPatterns as fusionPatterns, detectLiquidityBox as fusionBox, computeRiskScore as fusionRisk } from './fusion.js';

export const SCALP_VARIANTS = [
  { key: 'momentum',     label: 'Momentum',     color: '#d97706', description: 'Original — VWAP/ORB/breakout momentum patterns' },
  { key: 'fusion',       label: 'Fusion',        color: '#6366f1', description: 'Amalgamation — ≥2 transcript strategies must agree' },
];

const VARIANT_FNS = {
  momentum:      { detectPatterns: momentumPatterns, detectLiquidityBox: momentumBox, computeRiskScore: momentumRisk },
  fusion:        { detectPatterns: fusionPatterns,    detectLiquidityBox: fusionBox,   computeRiskScore: fusionRisk },
};

export function getScalpVariantFns(variantKey) {
  return VARIANT_FNS[variantKey] || VARIANT_FNS.momentum;
}

export const DEFAULT_SCALP_VARIANT = 'momentum';
