/**
 * Gate auth — SHA-256 hash of passphrase stored in localStorage.
 * Plaintext passphrase never leaves the browser or gets sent over the network.
 * Worker compares the hash directly against env.GATE_PASSPHRASE_HASH.
 *
 * Legacy names (getBatchToken, etc.) re-exported for backward compatibility
 * during migration. New code should use getGateToken, setGateToken, etc.
 */

const KEY = 'candlescan_gate_hash';

/** Compute SHA-256 hex hash of a string (browser crypto API). */
async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Get the stored hash (ready to send as X-Gate-Token). */
export function getGateToken() {
  try {
    return localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
}

/** Hash the passphrase and store the hash (not the plaintext). */
export async function setGateToken(passphrase) {
  try {
    const hash = await sha256(passphrase);
    localStorage.setItem(KEY, hash);
  } catch {
    /* quota */
  }
}

export function hasGateToken() {
  return !!getGateToken();
}

export function clearGateToken() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

// Migrate old key to new key on first load
try {
  const oldKey = 'candlescan_batch_key';
  const oldVal = localStorage.getItem(oldKey);
  if (oldVal && !localStorage.getItem(KEY)) {
    localStorage.setItem(KEY, oldVal);
    localStorage.removeItem(oldKey);
  }
} catch { /* ignore */ }

// Legacy re-exports
export const getBatchToken = getGateToken;
export const setBatchToken = setGateToken;
export const hasBatchToken = hasGateToken;
export const clearBatchToken = clearGateToken;
