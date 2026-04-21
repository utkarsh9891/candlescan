import { describe, it, expect } from 'vitest';
import { isNewer, pickLatestTag } from '../components/UpdatePrompt.jsx';

describe('UpdatePrompt semver comparator', () => {
  it('returns true when candidate is strictly newer', () => {
    expect(isNewer('v0.15.9', 'v0.15.8')).toBe(true);
    expect(isNewer('v0.16.0', 'v0.15.99')).toBe(true);
    expect(isNewer('v1.0.0', 'v0.99.99')).toBe(true);
  });

  it('returns false when candidate is equal', () => {
    expect(isNewer('v0.15.8', 'v0.15.8')).toBe(false);
  });

  it('returns false when candidate is older — the regression that produced the v0.15.0 downgrade prompt', () => {
    expect(isNewer('v0.15.0', 'v0.15.8')).toBe(false);
    expect(isNewer('v0.14.99', 'v0.15.0')).toBe(false);
    expect(isNewer('v0.0.1', 'v1.0.0')).toBe(false);
  });

  it('accepts both v-prefixed and bare semver strings', () => {
    expect(isNewer('0.15.9', 'v0.15.8')).toBe(true);
    expect(isNewer('v0.15.9', '0.15.8')).toBe(true);
  });

  it('returns false for unparseable input', () => {
    expect(isNewer('garbage', 'v0.15.8')).toBe(false);
    expect(isNewer('v0.15.8', '')).toBe(false);
  });
});

describe('pickLatestTag', () => {
  it('picks the semver-max even when the creation-order index 0 is lower', () => {
    const releases = [
      { tag_name: 'v0.15.0' },
      { tag_name: 'v0.15.8' },
      { tag_name: 'v0.15.7' },
    ];
    expect(pickLatestTag(releases)).toBe('v0.15.8');
  });

  it('returns null for empty or non-array input', () => {
    expect(pickLatestTag([])).toBeNull();
    expect(pickLatestTag(null)).toBeNull();
    expect(pickLatestTag(undefined)).toBeNull();
  });

  it('ignores releases with unparseable tags', () => {
    const releases = [
      { tag_name: 'beta-build' },
      { tag_name: 'v0.15.2' },
      { tag_name: null },
    ];
    expect(pickLatestTag(releases)).toBe('v0.15.2');
  });
});
