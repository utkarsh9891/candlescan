// AES-256-GCM encryption at rest for non-sensitive client-only values
// (e.g. Dhan PIN used to regenerate the daily access token).
//
// Key material is derived via HKDF from the gate hash (SHA-256 of the
// premium passphrase) already present in localStorage once the gate is
// unlocked. When the gate is cleared, stored ciphertext becomes unreadable
// until the passphrase is re-entered.
//
// This is "encryption at rest in the browser": it defeats casual inspection
// of localStorage (dev tools, sync backups, extensions that scrape by key
// name). A targeted attacker with full localStorage read+code-execution
// access can still derive the same key — that threat requires a
// server-held secret, which is outside the scope here.

const GATE_HASH_KEY = 'candlescan_gate_hash';
const SALT = new TextEncoder().encode('candlescan-local-cipher-v1');
const INFO = new TextEncoder().encode('aes-gcm-256');

function bufToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes.buffer;
}

async function deriveKey() {
  let gateHash;
  try { gateHash = localStorage.getItem(GATE_HASH_KEY); } catch { gateHash = null; }
  if (!gateHash || !/^[a-f0-9]{64}$/.test(gateHash)) {
    throw new Error('Gate not unlocked — cannot derive local cipher key');
  }
  const ikm = await crypto.subtle.importKey('raw', hexToBuf(gateHash), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: INFO },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Encrypts plaintext string. Returns base64 blob: [12-byte IV][ciphertext+tag].
// Throws if the gate is not unlocked.
export async function encryptLocal(plaintext) {
  const key = await deriveKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const blob = new Uint8Array(12 + ct.byteLength);
  blob.set(iv, 0);
  blob.set(new Uint8Array(ct), 12);
  return bufToBase64(blob.buffer);
}

// Decrypts a base64 blob produced by encryptLocal. Returns the plaintext
// string or null if decryption fails (wrong key, corrupted blob, etc.).
export async function decryptLocal(blob) {
  if (!blob) return null;
  try {
    const key = await deriveKey();
    const raw = new Uint8Array(base64ToBuf(blob));
    if (raw.byteLength <= 12) return null;
    const iv = raw.slice(0, 12);
    const ct = raw.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
