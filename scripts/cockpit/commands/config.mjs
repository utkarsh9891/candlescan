/**
 * `cockpit config` — print current effective config.
 *
 * Defaults to REDACTED output. Pass --show-secrets to print the full
 * file (only do this when you actually need the plain values, e.g. when
 * copying a topic into a password manager).
 */

import { readSecrets, exists, secretsPath } from '../lib/secrets-rw.mjs';
import { isEncrypted } from '../lib/gate.mjs';

export const help = `
cockpit config [--show-secrets] — print current effective config

  cockpit config                    redacted output (default — safe to share)
  cockpit config -- --show-secrets  full output, no redaction
`.trim();

const REDACT_KEYS = new Set(['topic', 'pin', 'apiSecret', 'accessToken']);

function redact(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (REDACT_KEYS.has(k) && typeof v === 'string' && v.length > 0) {
      const tag = isEncrypted(v) ? '<encrypted at rest>' : `<${v.length}-char value, redacted>`;
      out[k] = tag;
    } else if (typeof v === 'object') {
      out[k] = redact(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function run(args) {
  if (!exists()) {
    console.log(`no secrets at ${secretsPath()}`);
    console.log('run:  npm run cockpit:init');
    return;
  }
  const c = readSecrets();
  const showFull = args.includes('--show-secrets');
  console.log(`secrets: ${secretsPath()}`);
  if (!showFull) {
    console.log('(redacted — pass --show-secrets to reveal raw values)');
  }
  console.log(JSON.stringify(showFull ? c : redact(c), null, 2));
}
