/**
 * Scalp variant registry.
 * Maps variant keys to their engine functions + UI metadata.
 */

// Momentum (current/original) — import from parent engine files
import { detectPatterns as momentumPatterns } from '../patterns-scalp.js';
import { detectLiquidityBox as momentumBox } from '../liquidityBox-scalp.js';
import { computeRiskScore as momentumRisk } from '../risk-scalp.js';

// Transcript-based variants (rule-based, independent of momentum)
import { detectPatterns as boxPatterns, detectLiquidityBox as boxBox, computeRiskScore as boxRisk } from './boxTheory.js';
import { detectPatterns as qfPatterns, detectLiquidityBox as qfBox, computeRiskScore as qfRisk } from './quickFlip.js';
import { detectPatterns as tatPatterns, detectLiquidityBox as tatBox, computeRiskScore as tatRisk } from './touchAndTurn.js';
import { detectPatterns as fusionPatterns, detectLiquidityBox as fusionBox, computeRiskScore as fusionRisk } from './fusion.js';

export const SCALP_VARIANTS = [
  { key: 'momentum',     label: 'Momentum',     color: '#d97706', description: 'Original — VWAP/ORB/breakout momentum patterns' },
  { key: 'boxTheory',    label: 'Box Theory',    color: '#8b5cf6', description: 'Prev day high/low range — fade the extremes' },
  { key: 'quickFlip',    label: 'Quick Flip',    color: '#06b6d4', description: 'ORB liquidity candle → reversal candlestick outside range' },
  { key: 'touchAndTurn', label: 'Touch & Turn',  color: '#f43f5e', description: 'ORB + Fibonacci — limit order at range edge' },
  { key: 'fusion',       label: 'Fusion',        color: '#6366f1', description: 'Amalgamation — ≥2 transcript strategies must agree' },
];

const VARIANT_FNS = {
  momentum:      { detectPatterns: momentumPatterns, detectLiquidityBox: momentumBox, computeRiskScore: momentumRisk },
  boxTheory:     { detectPatterns: boxPatterns,      detectLiquidityBox: boxBox,      computeRiskScore: boxRisk },
  quickFlip:     { detectPatterns: qfPatterns,       detectLiquidityBox: qfBox,       computeRiskScore: qfRisk },
  touchAndTurn:  { detectPatterns: tatPatterns,      detectLiquidityBox: tatBox,      computeRiskScore: tatRisk },
  fusion:        { detectPatterns: fusionPatterns,    detectLiquidityBox: fusionBox,   computeRiskScore: fusionRisk },
};

export function getScalpVariantFns(variantKey) {
  return VARIANT_FNS[variantKey] || VARIANT_FNS.momentum;
}

export const DEFAULT_SCALP_VARIANT = 'momentum';
