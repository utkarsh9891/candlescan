/**
 * Batch scan auth — SHA-256 hash of passphrase stored in localStorage.
 * Plaintext passphrase never leaves the browser or gets sent over the network.
 * Worker compares the hash directly against env.BATCH_AUTH_HASH.
 */

const KEY = 'candlescan_batch_key';

/** Compute SHA-256 hex hash of a string (browser crypto API). */
async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Get the stored hash (ready to send as X-Batch-Token). */
export function getBatchToken() {
  try {
    return localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
}

/** Hash the passphrase and store the hash (not the plaintext). */
export async function setBatchToken(passphrase) {
  try {
    const hash = await sha256(passphrase);
    localStorage.setItem(KEY, hash);
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
