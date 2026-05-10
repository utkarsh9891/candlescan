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
import { ask, choose, confirm } from '../lib/prompts.mjs';
import { readSecrets, writeSecrets, secretsPath } from '../lib/secrets-rw.mjs';

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

  // ── host ──
  const hostName = await ask('cockpit hostname (Mac mDNS name or LAN IP)', {
    defaultValue: cur.host?.name || 'cockpit.local',
    required: true,
  });
  const portRaw = await ask('cockpit HTTP port', {
    defaultValue: String(cur.host?.port || 5174),
    required: true,
    validate: (v) => (Number.isFinite(+v) && +v > 0 && +v < 65536) ? null : 'invalid port',
  });

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
    host: { name: hostName, port: +portRaw },
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
  writeSecrets(next);
  console.log(`✓ wrote ${secretsPath()} (mode 0600)`);
  console.log('\nNext: npm run cockpit  (or  npm run cockpit:status  to confirm config)');
}
