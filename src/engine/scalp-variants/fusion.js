/**
 * Fusion scalp variant — amalgamation of all 4 transcript strategies.
 *
 * Runs Box Theory, Quick Flip, 4H Range, and Touch & Turn in parallel.
 * Only enters if ≥ 2 strategies agree on direction.
 * Uses the strongest individual signal for SL/target calculation.
 *
 * === HARD CONSTRAINTS ===
 * - maxHoldBars: 15 (scalp limit)
 * - Timeframe: 1m
 */

import { detectPatterns as boxPatterns, computeRiskScore as boxRisk } from './boxTheory.js';
import { detectPatterns as qfPatterns, computeRiskScore as qfRisk } from './quickFlip.js';
import { detectPatterns as fhrPatterns, computeRiskScore as fhrRisk } from './fourHourRange.js';
import { detectPatterns as tatPatterns, computeRiskScore as tatRisk } from './touchAndTurn.js';
import { noTrade, buildConfidence, confidenceToAction } from './shared.js';

const STRATEGIES = [
  { name: 'Box Theory', detect: boxPatterns, risk: boxRisk, weight: 1.0 },
  { name: 'Quick Flip', detect: qfPatterns, risk: qfRisk, weight: 1.0 },
  { name: '4H Range', detect: fhrPatterns, risk: fhrRisk, weight: 1.0 },
  { name: 'Touch & Turn', detect: tatPatterns, risk: tatRisk, weight: 1.0 },
];

/* ── Pattern Detection ───────────────────────────────────────── */

export function detectPatterns(candles, opts = {}) {
  if (!candles || candles.length < 10) return [];

  // Run all strategies
  const allPatterns = [];
  for (const strat of STRATEGIES) {
    const pats = strat.detect(candles, opts);
    for (const p of pats) {
      allPatterns.push({ ...p, _source: strat.name, _weight: strat.weight });
    }
  }

  if (!allPatterns.length) return [];

  // Count directional votes
  let bullishVotes = 0, bearishVotes = 0;
  let bullishStrength = 0, bearishStrength = 0;
  const bullishSources = new Set();
  const bearishSources = new Set();

  for (const p of allPatterns) {
    if (p.direction === 'bullish') {
      bullishVotes += p._weight;
      bullishStrength += p.strength * p._weight;
      bullishSources.add(p._source);
    } else if (p.direction === 'bearish') {
      bearishVotes += p._weight;
      bearishStrength += p.strength * p._weight;
      bearishSources.add(p._source);
    }
  }

  // Need ≥ 2 strategies agreeing
  const minAgreement = 2;
  const patterns = [];

  if (bullishSources.size >= minAgreement && bullishVotes > bearishVotes) {
    const avgStr = bullishStrength / bullishVotes;
    patterns.push({
      name: `Fusion Long (${bullishSources.size} agree)`,
      direction: 'bullish',
      strength: Math.min(0.95, avgStr + bullishSources.size * 0.05),
      reliability: Math.min(0.85, 0.60 + bullishSources.size * 0.05),
      category: 'fusion',
      _sources: [...bullishSources],
      _allPatterns: allPatterns.filter(p => p.direction === 'bullish'),
    });
  }

  if (bearishSources.size >= minAgreement && bearishVotes > bullishVotes) {
    const avgStr = bearishStrength / bearishVotes;
    patterns.push({
      name: `Fusion Short (${bearishSources.size} agree)`,
      direction: 'bearish',
      strength: Math.min(0.95, avgStr + bearishSources.size * 0.05),
      reliability: Math.min(0.85, 0.60 + bearishSources.size * 0.05),
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
  if (!top || !top._allPatterns) return noTrade(cur, candles);

  // Run risk scoring for each contributing strategy and pick the best
  let bestRisk = null;
  let bestConfidence = 0;

  for (const strat of STRATEGIES) {
    const stratPatterns = top._allPatterns.filter(p => p._source === strat.name);
    if (!stratPatterns.length) continue;

    const risk = strat.risk({ candles, patterns: stratPatterns, box, opts });
    if (risk.action !== 'NO TRADE' && risk.confidence > bestConfidence) {
      bestConfidence = risk.confidence;
      bestRisk = risk;
    }
  }

  if (!bestRisk) return noTrade(cur, candles);

  // Boost confidence based on number of agreeing sources
  const sourceCount = top._sources?.length || 1;
  const fusionBonus = (sourceCount - 1) * 3; // +3 per additional agreement
  const boostedConfidence = Math.min(100, bestRisk.confidence + fusionBonus);

  const direction = top.direction === 'bearish' ? 'short' : 'long';
  const action = confidenceToAction(boostedConfidence, direction);

  return {
    ...bestRisk,
    confidence: boostedConfidence,
    action,
    total: bestRisk.total + fusionBonus,
    maxHoldBars: 15,
  };
}
