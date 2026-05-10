/**
 * `cockpit init` — interactive first-run wizard.
 *
 * Prompts for: ntfy topic (or generates random one), cockpit hostname,
 * port, engine, index, confidence threshold, scan timeframe, scan
 * interval. Writes ~/.candlescan/cockpit/secrets.json.
 *
 * Idempotent: re-running with an existing secrets file shows current
 * values as defaults, so this doubles as an "edit config" wizard.
 */

import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { ask, askSecret, choose, confirm } from '../lib/prompts.mjs';
import { readSecrets, writeSecrets, secretsPath } from '../lib/secrets-rw.mjs';
import {
  verifyPassphrase,
  deriveKey,
  encryptSensitive,
} from '../lib/gate.mjs';

const DEFAULT_PORT = 5174;

/**
 * Pick a sensible default cockpit hostname:
 *   1. Mac's current LocalHostName via `scutil --get LocalHostName` →
 *      e.g. "macbook" → "macbook.local". This is the Bonjour name your
 *      phone resolves over mDNS — no IP needed, no manual rename needed.
 *   2. Fallback to "cockpit.local" if scutil isn't available (non-macOS,
 *      or the system call fails for any reason).
 *
 * Sanitises the LocalHostName to RFC-952-ish hostname chars; if the
 * result is empty after sanitisation, falls back to "cockpit.local".
 */
function detectHostname() {
  try {
    const raw = execSync('scutil --get LocalHostName', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    const safe = raw.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (safe) return `${safe}.local`;
  } catch {
    /* scutil missing / errored — fall through */
  }
  return 'cockpit.local';
}

export const help = `
cockpit init — interactive first-run setup

Prompts for ntfy topic + scan defaults, writes ~/.candlescan/cockpit/secrets.json.
Re-running shows current values as defaults so this also works for editing.
`.trim();

export async function run() {
  console.log('CandleScan Cockpit — first-run setup\n');
  const cur = readSecrets();
  const isEdit = Object.keys(cur).length > 0;
  if (isEdit) {
    console.log(`(editing existing secrets at ${secretsPath()})\n`);
  } else {
    console.log(`(creating new secrets at ${secretsPath()})\n`);
  }

  // ── ntfy topic ──
  console.log('ntfy topic: anyone with the topic name can read or push to it.');
  console.log('Pick something unguessable (32+ random chars) and store it in your password manager.\n');
  let topic = cur.ntfy?.topic || '';
  if (topic) {
    const change = await confirm(`current topic ends in "${topic.slice(-6)}". Change it?`, false);
    if (change) topic = '';
  }
  if (!topic) {
    const useGenerated = await confirm('Generate a random topic now?', true);
    if (useGenerated) {
      topic = 'candlescan-' + crypto.randomBytes(12).toString('hex');
      console.log(`generated: ${topic}`);
      console.log('  → save this in your password manager BEFORE continuing.');
      console.log('  → subscribe to this topic in the ntfy app on your phone.');
      const ok = await confirm('Saved + subscribed?', false);
      if (!ok) {
        console.log('aborting — re-run when ready.');
        return;
      }
    } else {
      topic = await ask('paste topic name', { required: true, validate: (v) => v.length < 8 ? 'too short — pick at least 8 chars' : null });
    }
  }

  // ── host: not prompted — auto-detect mDNS name + use default port ──
  // Editing host.name / host.port directly in secrets.json is the escape
  // hatch for anything non-standard.
  const hostName = cur.host?.name || detectHostname();
  const port = cur.host?.port || DEFAULT_PORT;
  console.log(`\nhost: http://${hostName}:${port}  (auto-detected from your Mac's LocalHostName)`);
  console.log('  edit secrets.json directly if you need a different host or port.\n');

  // ── scan ──
  const engine = await choose('engine', [
    { value: 'scalp', label: 'scalp (1m, ≤20min holds)' },
    { value: 'intraday', label: 'intraday (5m / 15m, EOD exit)' },
    { value: 'delivery', label: 'delivery (1d, multi-day)' },
  ], { defaultValue: cur.scan?.engine || 'intraday' });

  const index = await ask('index to scan', {
    defaultValue: cur.scan?.index || 'NIFTY 50',
    required: true,
  });
  const timeframe = await choose('scan timeframe', [
    { value: '1m', label: '1m' },
    { value: '5m', label: '5m' },
    { value: '15m', label: '15m' },
  ], { defaultValue: cur.scan?.timeframe || (engine === 'scalp' ? '1m' : '5m') });

  const minConfRaw = await ask('minimum confidence (0..100)', {
    defaultValue: String(cur.scan?.minConfidence ?? 75),
    required: true,
    validate: (v) => (Number.isFinite(+v) && +v >= 0 && +v <= 100) ? null : 'must be 0..100',
  });
  const intervalRaw = await ask('scan interval seconds', {
    defaultValue: String(cur.scan?.intervalSec ?? 60),
    required: true,
    validate: (v) => (Number.isFinite(+v) && +v >= 10) ? null : 'must be ≥ 10',
  });

  const exitIntervalRaw = await ask('exit-monitor interval seconds', {
    defaultValue: String(cur.exit?.intervalSec ?? 30),
    required: true,
    validate: (v) => (Number.isFinite(+v) && +v >= 10) ? null : 'must be ≥ 10',
  });

  const next = {
    ...cur,
    host: { name: hostName, port },
    ntfy: { ...(cur.ntfy || {}), topic },
    scan: {
      engine,
      index,
      timeframe,
      minConfidence: +minConfRaw,
      intervalSec: +intervalRaw,
    },
    exit: { intervalSec: +exitIntervalRaw },
  };

  console.log('\nReview:');
  console.log(JSON.stringify({ ...next, ntfy: { ...next.ntfy, topic: '<redacted>' } }, null, 2));

  const ok = await confirm('\nWrite to secrets.json?', true);
  if (!ok) {
    console.log('aborted.');
    return;
  }

  // If a gate is set, re-encrypt sensitive fields (the new ntfy.topic
  // we just wrote in plain) before persisting.
  let toWrite = next;
  if (next.gate?.salt) {
    console.log('\ngate is set — encrypting sensitive fields.');
    const passphrase = await askSecret('passphrase to unlock gate');
    if (!verifyPassphrase(next.gate, passphrase)) {
      console.log('✗ wrong passphrase — aborting.');
      return;
    }
    const key = deriveKey(next.gate, passphrase);
    toWrite = encryptSensitive(next, key);
  }

  writeSecrets(toWrite);
  console.log(`✓ wrote ${secretsPath()} (mode 0600)`);
  console.log('\nNext: npm run cockpit  (or  npm run cockpit:status  to confirm config)');
}
