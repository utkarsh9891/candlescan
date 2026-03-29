/**
 * Batch scan auth — passphrase stored in localStorage.
 * Worker validates SHA-256 hash of the passphrase against env.BATCH_AUTH_HASH.
 */

const KEY = 'candlescan_batch_key';

export function getBatchToken() {
  try {
    return localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
}

export function setBatchToken(passphrase) {
  try {
    localStorage.setItem(KEY, passphrase);
  } catch {
    /* quota */
  }
}

export function hasBatchToken() {
  return !!getBatchToken();
}

export function clearBatchToken() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
