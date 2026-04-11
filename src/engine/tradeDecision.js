/**
 * Trade decision flow — four phases that decide which candidates get
 * traded and how much size each gets. Shipped per the user's
 * architectural analysis (see docs/INTEGRATIONS.md).
 *
 *   Phase 1: filter         — hard binary, pre-pattern. "Is this
 *                             stock tradeable at all today?" Uses
 *                             per-stock signals only (liquidity,
 *                             margin eligibility, universe).
 *
 *   Phase 2: regime gate    — hard binary, post-pattern. "Given
 *                             today's market context, can I trade
 *                             in this direction on this stock?"
 *                             Uses day-level signals (VIX regime,
 *                             market-wide news, FII/DII flow).
 *
 *   Phase 3: rank           — continuous score. "Of the candidates
 *                             that passed filter+gate, which ones
 *                             should I take first?" Uses ONLY
 *                             per-stock signals that have been
 *                             empirically validated as predictive.
 *                             Currently: risk engine confidence
 *                             (pattern strength + relative strength
 *                             + volume + R:R + regime alignment)
 *                             plus news sentiment when aligned.
 *
 *   Phase 4: size           — position sizing multiplier. "For a
 *                             given candidate, how much of the
 *                             default position should I actually
 *                             deploy?" Uses day-level context to
 *                             modulate exposure without changing
 *                             which trades get picked.
 *
 * Design principle (the hard-won lesson):
 *   Global signals → control EXPOSURE (phases 1, 2, 4)
 *   Local signals  → rank TRADES (phase 3)
 *
 * Adding global signals to ranking shifts the effective threshold
 * and admits marginal trades that displace higher-quality setups.
 * The empirical sweep in PR #161 documents exactly this failure
 * mode across four different delta magnitudes.
 */

import { vixAllowsTrading, newsAlignment, liquidityAllowsTrading } from './marketContext.js';
import { isMarginEligible } from '../data/marginData.js';

/* ── Phase 1: filter (hard binary, pre-pattern) ─────────────────── */

/**
 * Should this stock be considered at all today?
 * Evaluated BEFORE pattern detection so we don't waste compute on
 * stocks that can't trade regardless of setup.
 *
 * @param {{symbol, avgPerBarVolume?}} stock
 * @param {{liquidityTier, marginEnabled, marginMap}} ctx
 * @returns {{ok: boolean, reason?: string}}
 */
export function filterStock(stock, ctx) {
  // Liquidity: too-illiquid names can't be scalped at 15L exposure
  if (ctx?.liquidityTier && !liquidityAllowsTrading(ctx.liquidityTier)) {
    return { ok: false, reason: `liquidity=${ctx.liquidityTier}` };
  }

  // Margin eligibility: if margin trading is enabled, the stock must
  // be in the MIS-eligible list. (Currently a soft penalty in
  // risk-scalp.js; left there for now to preserve backtest, but the
  // architecture supports migrating it here as a hard filter.)
  // if (ctx?.marginEnabled && ctx?.marginMap && !isMarginEligible(stock.symbol, ctx.marginMap)) {
  //   return { ok: false, reason: 'margin-ineligible' };
  // }

  return { ok: true };
}

/* ── Phase 2: regime gate (hard binary, post-pattern) ──────────── */

/**
 * Given a pattern has fired in a direction, should we allow the
 * trade given today's market context?
 *
 * @param {'long'|'short'} direction
 * @param {{vixRegime?, sentiment?, gap?, flow?, preWindowMove?}} ctx
 * @returns {{ok: boolean, reason?: string}}
 */
export function regimeGate(direction, ctx) {
  if (!ctx) return { ok: true };

  // VIX PANIC: scalping noise overwhelms edge in extreme vol. Shut down.
  if (ctx.vixRegime && !vixAllowsTrading(ctx.vixRegime)) {
    return { ok: false, reason: `vix=${ctx.vixRegime}` };
  }

  // News counter-STRONG: a strong counter-direction news story makes
  // this specific trade wrong regardless of technicals. The stock is
  // already repricing on the news.
  if (ctx.sentiment) {
    const align = newsAlignment(ctx.sentiment, direction);
    if (align === 'VETO') {
      return { ok: false, reason: `news=${ctx.sentiment}` };
    }
  }

  // Future gates that could live here without changing architecture:
  //   - circuit-breaker-hit stocks
  //   - earnings-day counter-trend block
  //   - stock on NSE ban list / ASM list
  //   - extreme intraday stock move (> 10% gap) — probably halted soon

  return { ok: true };
}

/* ── Phase 3: rank (continuous, per-stock signals only) ────────── */

/**
 * Ranking score for a candidate. Higher = better. The caller sorts
 * by this and picks the top N = max_trades.
 *
 * Right now we use the risk engine's `confidence` directly since it
 * already aggregates per-stock signals (pattern strength, relative
 * strength, volume, R:R, index-regime alignment). The only addition
 * is a news bonus if aligned sentiment is available — news is
 * per-stock/per-event which means it introduces legitimate
 * cross-sectional differentiation.
 *
 * Day-level context (VIX, gap, FII/DII flow, liquidity tier) is
 * NOT used here. Those move the whole pool uniformly and cause the
 * threshold-lowering problem documented in PR #161.
 *
 * @param {{confidence: number, direction: string}} risk
 * @param {{sentiment?: string}} ctx
 * @returns {number}
 */
export function rankScore(risk, ctx) {
  let score = risk.confidence;

  // Per-stock news bonus — legitimate ranking input
  if (ctx?.sentiment) {
    const align = newsAlignment(ctx.sentiment, risk.direction);
    if (align === 'VETO') {
      // Defense-in-depth: shouldn't reach here (regimeGate filters),
      // but if it does, rank it below everything.
      return -1;
    } else if (typeof align === 'number' && align > 0) {
      const isStrong = ctx.sentiment === 'BULLISH_STRONG' || ctx.sentiment === 'BEARISH_STRONG';
      score += isStrong ? 5 : 2;
    }
  }

  return score;
}

/* ── Phase 4: size (position sizing multiplier) ────────────────── */

/**
 * Position size multiplier in [MIN, MAX]. The caller multiplies the
 * base position size (e.g. Rs 3L) by this before computing shares.
 *
 * Global signals live HERE. Sizing is the right place to consume
 * them because reducing exposure on bad regimes is risk management,
 * not signal selection — it affects HOW MUCH to trade, not WHICH
 * trades to take.
 *
 * Sizing scale:
 *   0.5 — minimum (extreme regime, consecutive losses)
 *   1.0 — baseline (NORMAL regime, clean conditions)
 *   1.3 — maximum (LOW vol + aligned flow + ...) [reserved for future]
 *
 * @param {{vixRegime?, flow?, consecutiveLosses?}} ctx
 * @param {{direction: string}} [candidate]  optional, for flow alignment
 * @returns {{mult: number, reasons: string[]}}
 */
export function sizeMultiplier(ctx, candidate) {
  const reasons = [];
  let mult = 1.0;

  // VIX regime sizing: DISABLED by default. An empirical 17-day sweep
  // showed that scaling HIGH VIX days down by 0.65 hurt net P&L by
  // ~Rs 5k — HIGH VIX days in the April 2026 window had mixed results
  // (both big winners like Mar 25 +Rs 22k and losers like Apr 1 -Rs 13k),
  // so shrinking them down reduced wins AS MUCH as it reduced losses.
  //
  // The VIX regime signal isn't a clean win/loss separator in this
  // sample. Real use of VIX sizing probably needs to be combined with
  // something else (e.g. "VIX HIGH AND counter-trend to index AND no
  // sector confluence" → size down).
  //
  // Left as a comment-block toggle — the infrastructure is ready, the
  // scale factors just need tuning once we have a signal that actually
  // separates good days from bad.
  // if (ctx?.vixRegime === 'LOW')   mult *= 1.15;
  // if (ctx?.vixRegime === 'HIGH')  mult *= 0.65;
  // if (ctx?.vixRegime === 'PANIC') mult *= 0.30;
  if (ctx?.vixRegime) reasons.push(`vix:${ctx.vixRegime}(no-op)`);

  // Consecutive losses: protect capital after hits
  if (ctx?.consecutiveLosses != null) {
    if (ctx.consecutiveLosses >= 3) {
      mult *= 0.5;
      reasons.push('losses≥3×0.5');
    } else if (ctx.consecutiveLosses >= 2) {
      mult *= 0.75;
      reasons.push('losses≥2×0.75');
    }
  }

  // FII/DII flow alignment: INFRASTRUCTURE READY, scaling disabled.
  // Scaling up on aligned flow would need the flow signal to actually
  // predict sustained intraday direction, which requires historical
  // FII/DII data I don't have. Once cache/flow/<date>.json is
  // populated and a predictive test passes, this can be enabled.
  if (ctx?.flow && candidate?.direction) {
    reasons.push(`flow:${ctx.flow}(no-op)`);
  }

  // Clamp to safe bounds
  mult = Math.max(0.3, Math.min(1.5, mult));

  return { mult, reasons };
}
