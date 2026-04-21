/**
 * Tests for the TokenExpiredError class + helpers.
 *
 * Covers the invariants that batchScan and the UI banner depend on:
 *   - .code matches the expected string pattern per broker
 *   - .broker is normalized to lowercase
 *   - instanceof works for error-flow checks
 *   - isTokenExpiredError is duck-typed so errors serialized across
 *     realms (e.g. structuredClone, JSON round-trips) still match
 */

import { describe, it, expect } from 'vitest';
import { TokenExpiredError, isTokenExpiredError } from './brokerErrors.js';

describe('TokenExpiredError', () => {
  it('sets .code to TOKEN_EXPIRED_<BROKER> uppercased', () => {
    const dhan = new TokenExpiredError('dhan');
    expect(dhan.code).toBe('TOKEN_EXPIRED_DHAN');

    const kite = new TokenExpiredError('kite');
    expect(kite.code).toBe('TOKEN_EXPIRED_KITE');
  });

  it('normalizes .broker to lowercase', () => {
    const err = new TokenExpiredError('DHAN');
    expect(err.broker).toBe('dhan');
    expect(err.code).toBe('TOKEN_EXPIRED_DHAN');
  });

  it('is an instance of Error (so try/catch chains work)', () => {
    const err = new TokenExpiredError('dhan');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TokenExpiredError);
    expect(err.name).toBe('TokenExpiredError');
  });

  it('has a human-readable message', () => {
    const err = new TokenExpiredError('dhan');
    expect(err.message).toMatch(/dhan/i);
    expect(err.message).toMatch(/expired/i);
  });
});

describe('isTokenExpiredError', () => {
  it('returns true for TokenExpiredError instances', () => {
    expect(isTokenExpiredError(new TokenExpiredError('dhan'))).toBe(true);
    expect(isTokenExpiredError(new TokenExpiredError('kite'))).toBe(true);
  });

  it('returns true for duck-typed plain objects with a matching .code', () => {
    // Covers the "serialized across realms" case — an error that's been
    // structuredClone'd or JSON round-tripped loses its prototype but
    // keeps its fields. The UI banner flow needs to still recognize it.
    expect(isTokenExpiredError({ code: 'TOKEN_EXPIRED_DHAN' })).toBe(true);
    expect(isTokenExpiredError({ code: 'TOKEN_EXPIRED_KITE' })).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isTokenExpiredError(new Error('HTTP 500'))).toBe(false);
    expect(isTokenExpiredError({ code: 'SOME_OTHER_ERROR' })).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isTokenExpiredError(null)).toBe(false);
    expect(isTokenExpiredError(undefined)).toBe(false);
  });
});
