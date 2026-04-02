/**
 * Fusion scalp variant — amalgamation of the 3 transcript strategies.
 *
 * Runs Box Theory, Quick Flip, and Touch & Turn in parallel.
 * Enters when ≥ 2 strategies agree on direction.
 * Uses the strategy with the best R:R for SL/target.
 *
 * === HARD CONSTRAINTS ===
 * - maxHoldBars: 15 (scalp limit)
 */

import { detectPatterns as boxPatterns, computeRiskScore as boxRisk } from './boxTheory.js';
import { detectPatterns as qfPatterns, computeRiskScore as qfRisk } from './quickFlip.js';
import { detectPatterns as tatPatterns, computeRiskScore as tatRisk } from './touchAndTurn.js';
import { isMarginEligible } from '../../data/marginData.js';

const STRATEGIES = [
  { name: 'Box Theory', detect: boxPatterns, risk: boxRisk },
  { name: 'Quick Flip', detect: qfPatterns, risk: qfRisk },
  { name: 'Touch & Turn', detect: tatPatterns, risk: tatRisk },
];

/* ── Pattern Detection ───────────────────────────────────────── */

export function detectPatterns(candles, opts = {}) {
  if (!candles || candles.length < 10) return [];

  const allPatterns = [];
  for (const strat of STRATEGIES) {
    const pats = strat.detect(candles, opts);
    for (const p of pats) {
      allPatterns.push({ ...p, _source: strat.name });
    }
  }
  if (!allPatterns.length) return [];

  // Count directional agreement by unique source
  const bullishSources = new Set();
  const bearishSources = new Set();
  for (const p of allPatterns) {
    if (p.direction === 'bullish') bullishSources.add(p._source);
    else if (p.direction === 'bearish') bearishSources.add(p._source);
  }

  // Need ≥ 2 strategies agreeing
  const patterns = [];
  if (bullishSources.size >= 2 && bullishSources.size > bearishSources.size) {
    patterns.push({
      name: `Fusion Long (${bullishSources.size} agree)`,
      direction: 'bullish',
      strength: 0.85,
      reliability: 0.78,
      category: 'fusion',
      _sources: [...bullishSources],
      _allPatterns: allPatterns.filter(p => p.direction === 'bullish'),
    });
  }
  if (bearishSources.size >= 2 && bearishSources.size > bullishSources.size) {
    patterns.push({
      name: `Fusion Short (${bearishSources.size} agree)`,
      direction: 'bearish',
      strength: 0.85,
      reliability: 0.78,
      category: 'fusion',
      _sources: [...bearishSources],
      _allPatterns: allPatterns.filter(p => p.direction === 'bearish'),
    });
  }
  return patterns;
}

/* ── Liquidity Box ───────────────────────────────────────────── */

export function detectLiquidityBox(candles) {
  return null;
}

/* ── Risk Scoring ────────────────────────────────────────────── */

export function computeRiskScore({ candles, patterns, box, opts }) {
  const cur = candles[candles.length - 1];
  const top = patterns?.[0];
  if (!top || !top._sources) return _noTrade(cur);

  // Run risk for each contributing strategy, pick best R:R
  let bestRisk = null;
  let bestRR = 0;

  for (const strat of STRATEGIES) {
    if (!top._sources.includes(strat.name)) continue;
    const stratPatterns = (top._allPatterns || []).filter(p => p._source === strat.name);
    if (!stratPatterns.length) continue;
    const risk = strat.risk({ candles, patterns: stratPatterns, box, opts });
    if (risk.action !== 'NO TRADE' && risk.rr > bestRR) {
      bestRR = risk.rr;
      bestRisk = risk;
    }
  }

  if (!bestRisk) return _noTrade(cur);

  // Margin eligibility check
  if (opts?.margin && opts?.sym && !isMarginEligible(opts.sym, opts.marginMap)) {
    return _noTrade(cur);
  }

  const direction = top.direction === 'bearish' ? 'short' : 'long';

  return {
    ...bestRisk,
    confidence: 88, // Fusion bonus: multiple strategies agree
    action: direction === 'long' ? 'STRONG BUY' : 'STRONG SHORT',
    maxHoldBars: 15,
  };
}

function _noTrade(cur) {
  return {
    total: 0, confidence: 20,
    breakdown: { signalClarity: 0, lowNoise: 0, riskReward: 0, patternReliability: 0, confluence: 0 },
    level: 'low', action: 'NO TRADE',
    entry: cur.c, sl: cur.c, target: cur.c, rr: 0, direction: 'long',
    context: 'mid_range', maxHoldBars: 15,
  };
}
