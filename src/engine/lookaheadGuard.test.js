/**
 * Static guard test for CLAUDE.md rule #5: no lookahead in simulations.
 *
 * Every time-series lookup inside the simulator must use `t <= curTs` (or
 * equivalent slice-by-index) — NEVER `t < curEnd` or full-day aggregates.
 * Regressions here silently inflate backtest P&L and invalidate every
 * strategy comparison.
 *
 * Because we can't statically prove the full invariant, the test is a
 * linting guard: it flags the two concrete patterns that have historically
 * re-introduced lookahead, and pins the canonical "correct" shapes so a
 * stylistic refactor doesn't accidentally weaken them.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const SIM_FILES = [
  'scripts/simulate-day.mjs',
];

async function loadExecutable(relPath) {
  const src = await readFile(join(REPO_ROOT, relPath), 'utf8');
  // Strip comments — we only lint executable code.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\n)\s*\/\/[^\n]*/g, '');
}

describe('no-lookahead invariant (CLAUDE.md rule #5)', () => {
  it.each(SIM_FILES)('%s uses `t <= curTs`, never `t < curEnd`', async (relPath) => {
    const src = await loadExecutable(relPath);
    // Forbid the known-bad pattern: iterating index candles with `< curEnd`
    // (which peeks one bar into the future relative to `curTs`).
    expect(src, `${relPath} contains forbidden "t < curEnd" lookahead`).not.toMatch(/\.t\s*<\s*curEnd\b/);
    // Require the canonical pattern to still be present. If it's absent the
    // file has been refactored and we need to re-audit anyway.
    expect(src, `${relPath} missing canonical "t <= curTs" lookback`).toMatch(/\.t\s*<=\s*curTs\b/);
  });

  it.each(SIM_FILES)('%s slices the stock day with an upper bound of `dayBarIdx + 1` (exclusive future)', async (relPath) => {
    const src = await loadExecutable(relPath);
    // We want the day-slice to end at dayBarIdx + 1, not dayBarIdx + 2 or
    // dayCandles.length. The slice(0, dayBarIdx + 1) idiom proves the
    // upper bound is AT MOST the current bar (never future bars).
    expect(src, `${relPath} expected .slice(0, dayBarIdx + 1) to bound lookback`).toMatch(
      /dayCandles\.slice\(\s*0\s*,\s*dayBarIdx\s*\+\s*1\s*\)/,
    );
    // Forbid the obviously-broken full-day reference inside per-bar logic.
    expect(src, `${relPath} uses full-day aggregate dayCandles.slice(0, dayCandles.length)`).not.toMatch(
      /dayCandles\.slice\(\s*0\s*,\s*(?:sd\.)?dayCandles\.length\s*\)/,
    );
  });
});

describe('detectPatterns input surface', () => {
  it('patterns-scalp reads only through the current candle of its input', async () => {
    // detectPatterns receives the `candles` array the simulator chose to pass;
    // it therefore CANNOT look beyond what was passed in. This test just
    // sanity-checks that no part of the source reaches outside the array.
    const src = await loadExecutable('src/engine/patterns-scalp.js');
    // A lookahead violation inside patterns-scalp would be something like
    // `candles[n]` or `candles[n+1]`. n is the length, so candles[n] is
    // always undefined by design — but the pattern is a code smell.
    expect(src).not.toMatch(/candles\[\s*n\s*\+\s*\d+/);
  });
});
