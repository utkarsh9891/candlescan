/**
 * Optional passphrase-based encryption of sensitive secrets.json fields.
 *
 * Why: secrets.json is mode 0600 so only the user account can read it.
 * That's plenty for paper trading. Once real broker tokens land in the
 * file, an additional passphrase layer keeps a stolen home directory
 * (or a misplaced backup) from yielding live broker creds.
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
 * Encrypted field marker:
 *   any string of the form  "enc:v1:<iv>:<tag>:<ct>"  is treated as
 *   encrypted and round-tripped through decrypt() at boot.
 *
 * Limitation: launchd-started cockpits cannot prompt for passphrase. If
 * a gate is set AND the cockpit was started non-interactively, the
 * runtime errors out with a clear message. Interactive launches prompt.
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
 * Walk an object and apply a function to every string value. Used to
 * encrypt/decrypt all string fields under cfg.dhan and cfg.zerodha.
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

export function generateRandomPassphrase(words = 4) {
  // Convenience: a memorable random passphrase for first-time setup.
  // Not used unless the user opts in.
  const wordlist = ['oak', 'river', 'flame', 'silver', 'cloud', 'echo', 'amber', 'crimson',
    'verdant', 'storm', 'meadow', 'cedar', 'lunar', 'cobalt', 'quartz', 'vellum'];
  const out = [];
  for (let i = 0; i < words; i++) {
    out.push(wordlist[crypto.randomInt(0, wordlist.length)]);
  }
  return out.join('-') + '-' + crypto.randomInt(100, 1000);
}
