const CF_WORKER_URL = 'https://candlescan-proxy.utkarsh-dev.workers.dev';

const LS_KEYS = {
  gateHash: 'candlescan_gate_hash',
  gatePubkey: 'candlescan_gate_pubkey',
  vault: 'candlescan_vault',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeGetItem(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage full or unavailable – silently fail
  }
}

function safeRemoveItem(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * Convert an ArrayBuffer to a hex string.
 */
function bufToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert an ArrayBuffer to a base64 string.
 */
function bufToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert a base64 string to an ArrayBuffer.
 */
function base64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Import an RSA public key from PEM format for RSA-OAEP encryption.
 */
async function importRsaPublicKey(pem) {
  const pemBody = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s/g, '');
  const der = base64ToBuf(pemBody);
  return crypto.subtle.importKey(
    'spki',
    der,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash of a passphrase using Web Crypto API.
 * @param {string} passphrase
 * @returns {Promise<string>} hex-encoded hash
 */
export async function computeGateHash(passphrase) {
  const encoded = new TextEncoder().encode(passphrase);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return bufToHex(hashBuffer);
}

/**
 * Unlock the gate by validating a passphrase against the CF Worker.
 * On success, stores the gate hash and public key in localStorage.
 *
 * @param {string} passphrase
 * @returns {Promise<string>} RSA public key PEM
 * @throws {Error} if the passphrase is invalid or the request fails
 */
export async function unlockGate(passphrase) {
  const gateHash = await computeGateHash(passphrase);

  const res = await fetch(`${CF_WORKER_URL}/gate/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gateHash }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `Gate unlock failed (${res.status})`);
  }

  const data = await res.json();
  const publicKeyPem = data.gatePublicKey || data.publicKey;

  if (!publicKeyPem) {
    throw new Error('No public key returned from gate/unlock');
  }

  safeSetItem(LS_KEYS.gateHash, gateHash);
  safeSetItem(LS_KEYS.gatePubkey, publicKeyPem);

  return publicKeyPem;
}

/**
 * Check whether the gate has been unlocked (gate hash exists in localStorage).
 * @returns {boolean}
 */
export function isGateUnlocked() {
  return safeGetItem(LS_KEYS.gateHash) !== null;
}

/**
 * Return the stored gate hash (used as an auth token in API headers).
 * @returns {string|null}
 */
export function getGateToken() {
  return safeGetItem(LS_KEYS.gateHash);
}

/**
 * Store a gate hash directly in localStorage.
 * Useful for migration scenarios where the gate is set without unlocking.
 * @param {string} hash
 */
export function setGateToken(hash) {
  safeSetItem(LS_KEYS.gateHash, hash);
}

/**
 * Encrypt credentials using a hybrid RSA-OAEP + AES-256-GCM approach and
 * store the resulting blob in localStorage.
 *
 * Layout of the stored base64 blob (raw bytes):
 *   [2 bytes: RSA ciphertext length (big-endian)]
 *   [RSA-encrypted AES key]
 *   [12 bytes: AES-GCM IV]
 *   [AES-GCM ciphertext (includes auth tag)]
 *
 * @param {string} publicKeyPem  RSA public key in PEM format
 * @param {object} credentials   Plain object to encrypt
 */
export async function encryptToVault(publicKeyPem, credentials) {
  const rsaKey = await importRsaPublicKey(publicKeyPem);

  // Generate a random AES-256-GCM key
  const aesKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable so we can export & RSA-encrypt it
    ['encrypt'],
  );

  // Export raw AES key bytes (32 bytes)
  const rawAesKey = await crypto.subtle.exportKey('raw', aesKey);

  // Encrypt the AES key with RSA-OAEP
  const encryptedAesKey = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    rsaKey,
    rawAesKey,
  );

  // Encrypt credentials JSON with AES-256-GCM
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(credentials));
  const aesCiphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    plaintext,
  );

  // Assemble blob: [2-byte RSA len][RSA ciphertext][12-byte IV][AES ciphertext]
  const rsaLen = encryptedAesKey.byteLength;
  const totalLen = 2 + rsaLen + 12 + aesCiphertext.byteLength;
  const blob = new Uint8Array(totalLen);

  // Write RSA ciphertext length as 2-byte big-endian
  blob[0] = (rsaLen >> 8) & 0xff;
  blob[1] = rsaLen & 0xff;

  // Write RSA-encrypted AES key
  blob.set(new Uint8Array(encryptedAesKey), 2);

  // Write AES-GCM IV
  blob.set(iv, 2 + rsaLen);

  // Write AES-GCM ciphertext (includes auth tag)
  blob.set(new Uint8Array(aesCiphertext), 2 + rsaLen + 12);

  safeSetItem(LS_KEYS.vault, bufToBase64(blob.buffer));
}

/**
 * Return the encrypted vault blob from localStorage (base64 string).
 * @returns {string|null}
 */
export function getVaultBlob() {
  return safeGetItem(LS_KEYS.vault);
}

/**
 * Check whether an encrypted vault exists in localStorage.
 * @returns {boolean}
 */
export function hasVault() {
  return safeGetItem(LS_KEYS.vault) !== null;
}

/** Get the stored RSA public key PEM. */
export function getGatePublicKey() {
  return safeGetItem(LS_KEYS.gatePubkey);
}

/**
 * Remove only the encrypted vault blob (access token) from localStorage.
 * Preserves gate hash, public key, and API key/secret.
 */
export function clearVault() {
  safeRemoveItem(LS_KEYS.vault);
}

/**
 * Remove all gate-related data from localStorage.
 */
export function clearGate() {
  safeRemoveItem(LS_KEYS.gateHash);
  safeRemoveItem(LS_KEYS.gatePubkey);
  safeRemoveItem(LS_KEYS.vault);
}
