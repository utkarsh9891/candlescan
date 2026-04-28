/**
 * Regression guard for Dhan token-expiry classification.
 *
 * Before this test, the body-marker regex matched without a status gate:
 * any 4xx/5xx whose body contained "unauthorized" (CF gateway boilerplate
 * or Dhan's own rate-limit text) was reclassified as a token expiry. The
 * dataSourceFetch self-heal then nuked the user's vault on a transient
 * 429. These tests pin the corrected logic — token-expiry requires an
 * auth-related status (401, or 403 + marker).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isTokenExpiredError } from './brokerErrors.js';

vi.mock('./dhanInstruments.js', () => ({
  hasCachedInstruments: () => true,
  resolveDhanSecurityId: () => '12345',
}));
vi.mock('./chartCacheLocal.js', () => ({
  getCachedChart: () => null,
  setCachedChart: () => {},
}));

const VAULT = 'fake-vault-blob';
const GATE_TOKEN = 'fake-gate-token';

async function callFetcher(symbol = 'RELIANCE', timeframe = '5m') {
  const { fetchDhanOHLCV } = await import('./dhanFetcher.js');
  return fetchDhanOHLCV(symbol, timeframe, { vault: VAULT, gateToken: GATE_TOKEN });
}

function mockHttpResponse({ status, body }) {
  global.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => { try { return JSON.parse(body); } catch { return {}; } },
  }));
}

describe('dhanFetcher — token-expiry classification', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
    vi.resetModules();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('throws TokenExpiredError on bare 401 (Dhan canonical token-invalid)', async () => {
    mockHttpResponse({ status: 401, body: '' });
    await expect(callFetcher()).rejects.toSatisfy(isTokenExpiredError);
  });

  it('throws TokenExpiredError on 403 with DH-901 body marker', async () => {
    mockHttpResponse({
      status: 403,
      body: JSON.stringify({ error: 'Dhan API 403: DH-901 Invalid Token' }),
    });
    await expect(callFetcher()).rejects.toSatisfy(isTokenExpiredError);
  });

  it('does NOT throw TokenExpiredError on 429 even when body contains "unauthorized"', async () => {
    // This is the regression: a 429 with "unauthorized" anywhere in the body
    // was being classified as token expiry, which then triggered the
    // dataSourceFetch self-heal and silently cleared the user's vault.
    mockHttpResponse({
      status: 429,
      body: JSON.stringify({ error: 'Dhan API 429: Unauthorized rate limit exceeded' }),
    });
    const result = await callFetcher();
    expect(result.candles).toEqual([]);
    expect(result.error).toMatch(/429/);
    expect(isTokenExpiredError(result.error)).toBe(false);
  });

  it('does NOT throw TokenExpiredError on 500 with token-marker text', async () => {
    mockHttpResponse({
      status: 500,
      body: JSON.stringify({ error: 'upstream Invalid_Authentication noise' }),
    });
    const result = await callFetcher();
    expect(result.candles).toEqual([]);
    expect(result.error).toMatch(/500/);
  });

  it('does NOT throw TokenExpiredError on 403 without a token marker', async () => {
    mockHttpResponse({
      status: 403,
      body: JSON.stringify({ error: 'forbidden — subscription expired' }),
    });
    const result = await callFetcher();
    expect(result.candles).toEqual([]);
    expect(result.error).toMatch(/403/);
  });
});
