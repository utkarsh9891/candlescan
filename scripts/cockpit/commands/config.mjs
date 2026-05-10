/**
 * `cockpit config` — print current effective config (redacted).
 *
 * Convenient pre-flight check. ntfy topic + any encrypted/secret fields
 * are masked so the output is safe to paste into a bug report.
 */

import { readSecrets, exists, secretsPath } from '../lib/secrets-rw.mjs';
import { isEncrypted } from '../lib/gate.mjs';

export const help = `
cockpit config — print current effective config (redacted)

ntfy topic and broker tokens are masked. Use this to confirm what the
cockpit will load on next boot.
`.trim();

const REDACT_KEYS = new Set(['topic', 'pin', 'apiSecret', 'accessToken', 'verifier', 'salt']);

function redact(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (REDACT_KEYS.has(k) && typeof v === 'string' && v.length > 0) {
      out[k] = `<${v.length}-char value, redacted>`;
    } else if (isEncrypted(v)) {
      out[k] = '<encrypted, gate required>';
    } else if (typeof v === 'object') {
      out[k] = redact(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function run() {
  if (!exists()) {
    console.log(`no secrets at ${secretsPath()}`);
    console.log('run:  npm run cockpit:init');
    return;
  }
  const c = readSecrets();
  console.log(`secrets: ${secretsPath()}`);
  console.log(JSON.stringify(redact(c), null, 2));
}
