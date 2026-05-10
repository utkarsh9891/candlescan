/**
 * Optional passphrase that encrypts sensitive secrets.json fields at rest.
 *
 * Why this matters even today:
 *   - secrets.json is mode 0600 → other Unix users can't read it. That
 *     does NOT protect against:
 *       • Time Machine backups (file copies are unencrypted on the backup
 *         volume)
 *       • iCloud Drive / Dropbox / external sync touching ~/
 *       • shoulder-surfing or `cat secrets.json` while you're away
 *       • any process running as your user (browsers, tools, malware)
 *   - With a gate set, the file at rest contains only ciphertext for the
 *     sensitive fields. Decryption needs the passphrase, which lives in
 *     your head + password manager — not on disk.
 *
 * Crypto:
 *   - PBKDF2-SHA256, 200k iterations, 16-byte salt, 32-byte derived key
 *   - AES-256-GCM, 12-byte IV, embedded auth tag
 *   - Verifier = pbkdf2(passphrase, salt) compared time-safely
 *
 * Format on disk inside secrets.json:
 *   "gate": {
 *     "v": 1,
 *     "algo": "pbkdf2-sha256+aes-256-gcm",
 *     "iterations": 200000,
 *     "salt": "<hex>",
 *     "verifier": "<hex>"
 *   }
 *
 * Encrypted field marker: any string of the form  "enc:v1:<iv>:<tag>:<ct>"
 * is treated as encrypted and round-tripped through decrypt() at boot.
 *
 * Limitation: non-interactive launches (no TTY) can't prompt for the
 * passphrase. The cockpit is started manually anyway, so this isn't a
 * real constraint — but the runtime errors out clearly if a gate is set
 * and stdin is not a TTY (e.g. `nohup ... &`).
 */

import crypto from 'node:crypto';

const ITERATIONS = 200_000;
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const ENC_PREFIX = 'enc:v1:';

export function makeGateConfig(passphrase) {
  const salt = crypto.randomBytes(SALT_LEN);
  const verifier = crypto.pbkdf2Sync(passphrase, salt, ITERATIONS, 32, 'sha256');
  return {
    v: 1,
    algo: 'pbkdf2-sha256+aes-256-gcm',
    iterations: ITERATIONS,
    salt: salt.toString('hex'),
    verifier: verifier.toString('hex'),
  };
}

export function verifyPassphrase(gateConfig, passphrase) {
  if (!gateConfig?.salt || !gateConfig?.verifier) return false;
  const salt = Buffer.from(gateConfig.salt, 'hex');
  const got = crypto.pbkdf2Sync(passphrase, salt, gateConfig.iterations || ITERATIONS, 32, 'sha256');
  const expected = Buffer.from(gateConfig.verifier, 'hex');
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(got, expected);
}

export function deriveKey(gateConfig, passphrase) {
  const salt = Buffer.from(gateConfig.salt, 'hex');
  return crypto.pbkdf2Sync(passphrase, salt, gateConfig.iterations || ITERATIONS, KEY_LEN, 'sha256');
}

export function encrypt(plaintext, key) {
  if (plaintext == null || plaintext === '') return plaintext;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

export function decrypt(blob, key) {
  if (!isEncrypted(blob)) return blob;
  const [, , ivHex, tagHex, ctHex] = blob.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function isEncrypted(blob) {
  return typeof blob === 'string' && blob.startsWith(ENC_PREFIX);
}

/**
 * Walk an object tree and apply a fn to every string value. Used to
 * encrypt or decrypt the entire cfg.dhan / cfg.zerodha subtrees in one
 * pass without naming individual fields.
 */
export function mapStrings(obj, fn) {
  if (obj == null || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string') out[k] = fn(v);
    else if (typeof v === 'object') out[k] = mapStrings(v, fn);
    else out[k] = v;
  }
  return out;
}

/**
 * Fields the gate should encrypt. Listed explicitly so we never
 * accidentally encrypt a non-secret like ntfy.server (the URL).
 */
export const ENCRYPTED_PATHS = [
  ['ntfy', 'topic'],
  ['dhan', 'pin'],
  ['zerodha', 'apiSecret'],
  ['zerodha', 'accessToken'],
];

function getPath(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[path[path.length - 1]] = value;
}

/**
 * Apply encrypt() to every ENCRYPTED_PATHS field that's currently plain.
 * Returns a new top-level cfg object; doesn't mutate the input.
 */
export function encryptSensitive(cfg, key) {
  const next = JSON.parse(JSON.stringify(cfg));
  for (const path of ENCRYPTED_PATHS) {
    const v = getPath(next, path);
    if (typeof v === 'string' && v.length > 0 && !isEncrypted(v)) {
      setPath(next, path, encrypt(v, key));
    }
  }
  return next;
}

/**
 * Apply decrypt() to every ENCRYPTED_PATHS field that's currently encrypted.
 * Returns a new top-level cfg object; doesn't mutate the input.
 */
export function decryptSensitive(cfg, key) {
  const next = JSON.parse(JSON.stringify(cfg));
  for (const path of ENCRYPTED_PATHS) {
    const v = getPath(next, path);
    if (isEncrypted(v)) {
      setPath(next, path, decrypt(v, key));
    }
  }
  return next;
}
