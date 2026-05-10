/**
 * `cockpit config` — print current effective config.
 *
 * Defaults to FULL output (this is your machine, your secrets file, your
 * terminal). Pass --redacted to mask the ntfy topic + broker secrets
 * before sharing the output (e.g. in a bug report).
 */

import { readSecrets, exists, secretsPath } from '../lib/secrets-rw.mjs';

export const help = `
cockpit config [--redacted] — print current effective config

  cockpit config            full output (default; safe on your own machine)
  cockpit config --redacted mask ntfy topic + broker secrets for sharing
`.trim();

const REDACT_KEYS = new Set(['topic', 'pin', 'apiSecret', 'accessToken']);

function redact(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (REDACT_KEYS.has(k) && typeof v === 'string' && v.length > 0) {
      out[k] = `<${v.length}-char value, redacted>`;
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
  const isRedacted = args.includes('--redacted') || args.includes('-r');
  console.log(`secrets: ${secretsPath()}`);
  if (isRedacted) console.log('(redacted — safe to share)');
  console.log(JSON.stringify(isRedacted ? redact(c) : c, null, 2));
}
