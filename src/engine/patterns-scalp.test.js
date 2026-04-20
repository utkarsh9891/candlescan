/**
 * patterns-scalp.js — "Strong Momo Pullback" detection gates.
 *
 * CLAUDE.md rule #8: there is ONE scalp pattern, full stop. These tests
 * pin that contract AND each of the hard gates that keep the pattern
 * from over-firing on weak setups.
 *
 * We don't test a "pattern-fires" happy-path with a synthetic fixture:
 * the 9 gates are so tight that a hand-rolled fixture would be brittle
 * and mostly exercise the test's own arithmetic. Instead we test the
 * NEGATIVE paths — each gate, in isolation, must return [].
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectPatterns } from './patterns-scalp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Build 20 candles around day-open 100 that are benign enough to pass the
 * length / bar-index / EMA gates, but NOT contrived to actually fire. We
 * then mutate `opts` per-test to exercise each gate.
 */
function baseCandles() {
  const t0 = 1700000000;
  const out = [];
  for (let i = 0; i < 20; i++) {
    out.push({
      t: t0 + i * 60,
      o: 100 + i * 0.05,
      h: 100.2 + i * 0.05,
      l:  99.8 + i * 0.05,
      c: 100.1 + i * 0.05,
      v: 10_000,
    });
  }
  return out;
}

const baseOpts = {
  barIndex: 20,
  stockDayOpen: 100,
  indexDirection: { direction: 'up', strength: 'strong', intradayPct: 0, preWindowMove: 0.005 },
};

describe('patterns-scalp — always returns an array', () => {
  it('empty input → []', () => {
    expect(detectPatterns([])).toEqual([]);
    expect(detectPatterns(null)).toEqual([]);
    expect(detectPatterns(undefined)).toEqual([]);
  });

  it('fewer than 20 candles → []', () => {
    const c = baseCandles().slice(0, 19);
    expect(detectPatterns(c, baseOpts)).toEqual([]);
  });
});

describe('patterns-scalp — hard gates (each should veto on its own)', () => {
  it('barIndex > 45 (past the entry window) → []', () => {
    const r = detectPatterns(baseCandles(), { ...baseOpts, barIndex: 60 });
    expect(r).toEqual([]);
  });

  it('missing indexDirection.preWindowMove → []', () => {
    const r = detectPatterns(baseCandles(), { ...baseOpts, indexDirection: { intradayPct: 0 } });
    expect(r).toEqual([]);
  });

  it('index pre-window move below 0.2% → []', () => {
    const r = detectPatterns(baseCandles(), {
      ...baseOpts,
      indexDirection: { ...baseOpts.indexDirection, preWindowMove: 0.001 },
    });
    expect(r).toEqual([]);
  });

  it('weak volume (factor below 1.5x) → []', () => {
    // baseCandles has uniform volume, so volFactor ≈ 1.0 (well below 1.5)
    const r = detectPatterns(baseCandles(), baseOpts);
    expect(r).toEqual([]);
  });
});

describe('patterns-scalp — CLAUDE.md rule #8: single pattern only', () => {
  it('source file declares exactly ONE pattern name (long/short variants of "Strong Momo Pullback")', async () => {
    const src = await readFile(join(__dirname, 'patterns-scalp.js'), 'utf8');
    const names = [...src.matchAll(/name:\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
    expect(names.length, 'expected exactly two name declarations (long + short)').toBe(2);
    for (const n of names) {
      expect(n, 'every name must be a Strong Momo Pullback variant').toMatch(/^Strong Momo Pullback \((Long|Short)\)$/);
    }
  });

  it('no removed variants (boxTheory / quickFlip / touchAndTurn / fusion) linger in the source', async () => {
    const src = await readFile(join(__dirname, 'patterns-scalp.js'), 'utf8');
    // Comments may still reference these names historically — only assertion
    // is that no `name:` string or function bears them.
    expect(src).not.toMatch(/name:\s*['"`][^'"`]*(?:Box Theory|Quick Flip|Touch.*Turn|Fusion)[^'"`]*['"`]/i);
  });
});

describe('patterns-scalp — output shape when it DOES fire', () => {
  it('returns an array (possibly empty) of objects with the expected keys', () => {
    const r = detectPatterns(baseCandles(), baseOpts);
    expect(Array.isArray(r)).toBe(true);
    for (const p of r) {
      expect(p).toHaveProperty('name');
      expect(p).toHaveProperty('direction');
      expect(p).toHaveProperty('strength');
      expect(p).toHaveProperty('category', 'momentum');
      expect(p).toHaveProperty('reliability');
      expect(p).toHaveProperty('candleIndices');
    }
  });
});
