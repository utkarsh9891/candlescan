/**
 * `cockpit rotate-topic` — generate a new ntfy topic, notify the OLD
 * topic so your phone-side ntfy app gets the new name in a notification,
 * then update secrets.json.
 *
 * After this runs you must:
 *   1. Subscribe to the new topic in the ntfy app on your phone.
 *   2. Unsubscribe from the old one.
 *   3. Update your password manager.
 *   4. Restart the cockpit daemon.
 */

import crypto from 'node:crypto';
import { confirm } from '../lib/prompts.mjs';
import { readSecrets, writeSecrets } from '../lib/secrets-rw.mjs';

export const help = `
cockpit rotate-topic — generate a new ntfy topic and notify the old one

Generates 24 random hex chars, sends a notification to the OLD topic
announcing the new name (so your phone gets the message), then writes
the new topic to secrets.json. You then resubscribe on your phone.

If you suspect a topic leak, rotate. Cheap and clean.
`.trim();

export async function run() {
  const cur = readSecrets();
  const oldTopic = cur.ntfy?.topic;
  if (!oldTopic) {
    console.log('no current topic — run:  npm run cockpit:init');
    return;
  }
  const newTopic = 'candlescan-' + crypto.randomBytes(12).toString('hex');
  const server = cur.ntfy?.server || 'https://ntfy.sh';

  console.log(`current: ${oldTopic.slice(0, 12)}…${oldTopic.slice(-4)}`);
  console.log(`new:     ${newTopic}`);
  console.log('  → save the new value in your password manager BEFORE confirming.');

  const ok = await confirm('Send announcement to old topic and rotate?', false);
  if (!ok) {
    console.log('aborted.');
    return;
  }

  // Notify the OLD topic so the user's phone receives the new name once.
  try {
    const res = await fetch(server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: oldTopic,
        title: 'ntfy topic rotated',
        message: `New topic: ${newTopic}\nSubscribe in the ntfy app, then unsubscribe from this one.`,
        priority: 5,
        tags: ['key', 'rotating_light'],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.log(`⚠ old-topic notify failed: HTTP ${res.status} ${text}`.trim());
      const proceed = await confirm('Continue with rotation anyway?', false);
      if (!proceed) {
        console.log('aborted; topic unchanged.');
        return;
      }
    } else {
      console.log('✓ announced to old topic.');
    }
  } catch (e) {
    console.log(`⚠ old-topic notify failed: ${e.message}`);
    const proceed = await confirm('Continue with rotation anyway?', false);
    if (!proceed) {
      console.log('aborted; topic unchanged.');
      return;
    }
  }

  const next = { ...cur, ntfy: { ...cur.ntfy, topic: newTopic } };
  writeSecrets(next);
  console.log('✓ secrets.json updated.');
  console.log(`\nNext steps on your phone:`);
  console.log(`  1. ntfy app → Subscribe to topic → ${newTopic}`);
  console.log(`  2. Unsubscribe from the old topic.`);
  console.log(`Then restart the daemon:  npm run cockpit`);
}
