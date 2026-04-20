/**
 * Pin the two dollar-sensitive constants called out as non-negotiables in
 * CLAUDE.md rules #6 and #7. Changing either silently regresses every
 * backtest P&L figure we've ever published.
 *
 * MARGIN_MULTIPLIER   — 5x leverage (3L capital controls 15L exposure)
 * TX_COST_PCT         — 0.02% per side (0.04% round-trip, premium broker)
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MARGIN_MULTIPLIER } from '../data/marginData.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

describe('CLAUDE.md constants — non-negotiable', () => {
  it('MARGIN_MULTIPLIER === 5 (rule #6)', () => {
    expect(MARGIN_MULTIPLIER).toBe(5);
  });

  it('TX_COST_PCT === 0.0002 in scripts/simulate-day.mjs (rule #7)', async () => {
    const src = await readFile(join(REPO_ROOT, 'scripts/simulate-day.mjs'), 'utf8');
    // Exact line — any drift (0.0005 retail, 0.0003, etc.) fails the test
    expect(src).toMatch(/const TX_COST_PCT = 0\.0002;/);
  });
});
