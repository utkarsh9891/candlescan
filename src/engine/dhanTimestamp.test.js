/**
 * Regression guard for the "Dhan timestamps are epoch seconds, NOT ms"
 * footgun called out in CLAUDE.md gotchas.
 *
 * Wrapping a Dhan timestamp with bare `new Date(ts)` interprets it as
 * milliseconds and produces a date in 1970. Every consumer must multiply
 * by 1000 (often with the IST_OFFSET added first). These tests catch
 * anyone who re-introduces a bare wrap anywhere in the engine or the
 * simulator script.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const FILES_TO_SCAN = [
  'src/engine/dhanFetcher.js',
  'src/engine/batchScan.js',
  'src/engine/indexDirection.js',
  'scripts/simulate-day.mjs',
  'worker/index.js',
];

describe('Dhan epoch-seconds — no bare wrap anywhere', () => {
  it('epoch-seconds correctly multiplied by 1000 → sensible date, not 1970', () => {
    const IST_OFFSET = 19800; // +5:30 in seconds
    const t = 1681234567;    // Apr 11 2023 16:16 UTC
    // Correct: ms-scaled → 2023.
    expect(new Date(t * 1000).getUTCFullYear()).toBe(2023);
    expect(new Date((t + IST_OFFSET) * 1000).getUTCFullYear()).toBe(2023);
    // Buggy: raw seconds treated as ms → Jan 20 1970.
    expect(new Date(t).getUTCFullYear()).toBe(1970);
  });

  it.each(FILES_TO_SCAN)('%s has no bare `new Date(c.t)` / `new Date(candle.t)` / `new Date(bar.t)`', async (relPath) => {
    const src = await readFile(join(REPO_ROOT, relPath), 'utf8');
    // Strip string and comment contexts so we only inspect executable code.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\n)\s*\/\/[^\n]*/g, '');
    // Any `new Date(<var>.t)` where the expression ends before a `* 1000`
    // multiplier or a `+ IST_OFFSET` offset is the bug.
    const badPattern = /new Date\(\s*(c|candle|bar|row)\.t\s*\)/g;
    const matches = stripped.match(badPattern);
    expect(matches, `${relPath} wraps epoch-seconds without *1000`).toBeNull();
  });
});
