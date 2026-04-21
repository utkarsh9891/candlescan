import { describe, it, expect } from 'vitest';
import { CF_WORKER_URL, cfUrl } from './transport.js';

describe('transport', () => {
  it('exports a non-empty Worker URL', () => {
    expect(typeof CF_WORKER_URL).toBe('string');
    expect(CF_WORKER_URL).toMatch(/^https:\/\//);
  });

  it('cfUrl handles leading-slashed paths', () => {
    expect(cfUrl('/market/vix')).toBe(`${CF_WORKER_URL}/market/vix`);
  });

  it('cfUrl handles bare paths by inserting a slash', () => {
    expect(cfUrl('market/vix')).toBe(`${CF_WORKER_URL}/market/vix`);
  });

  it('cfUrl preserves query strings', () => {
    expect(cfUrl('/news/google?symbol=RELIANCE')).toBe(
      `${CF_WORKER_URL}/news/google?symbol=RELIANCE`
    );
  });

  it('cfUrl returns base URL for empty path', () => {
    expect(cfUrl('')).toBe(CF_WORKER_URL);
    expect(cfUrl()).toBe(CF_WORKER_URL);
  });
});
