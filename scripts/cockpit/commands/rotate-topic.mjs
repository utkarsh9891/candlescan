/**
 * `cockpit rotate-topic` — generate a new ntfy topic and update secrets.json.
 *
 * Important: this command does NOT notify any ntfy channel. If the old
 * topic was leaked, sending the new topic over the old one would just
 * leak the new topic too. The new topic is printed to the local terminal
 * only; copy it from there into your password manager and the ntfy app
 * on your phone.
 */

import crypto from 'node:crypto';
import { confirm } from '../lib/prompts.mjs';
import { readSecrets, writeSecrets } from '../lib/secrets-rw.mjs';

export const help = `
cockpit rotate-topic — generate a new ntfy topic locally (no remote notify)

Generates a fresh random topic, prints it to this terminal, and updates
secrets.json. Does NOT push anything to the old topic — if the old topic
was compromised, that channel is treated as untrusted.

After running:
  1. Copy the new topic into your password manager.
  2. ntfy app → Subscribe to topic → paste the new topic.
  3. Unsubscribe from the old topic in the ntfy app.
  4. Restart the cockpit daemon.
`.trim();

export async function run() {
  const cur = readSecrets();
  const oldTopic = cur.ntfy?.topic;
  if (!oldTopic) {
    console.log('no current topic — run:  npm run cockpit:init');
    return;
  }
  const newTopic = 'candlescan-' + crypto.randomBytes(12).toString('hex');

  console.log(`current: ${oldTopic.slice(0, 12)}…${oldTopic.slice(-4)}`);
  console.log(`new:     ${newTopic}`);
  console.log('');
  console.log('Save the new topic in your password manager BEFORE confirming.');
  console.log('No remote notification is sent — the new value lives only here.');
  console.log('');

  const ok = await confirm('Write new topic to secrets.json?', false);
  if (!ok) {
    console.log('aborted; topic unchanged.');
    return;
  }

  const next = { ...cur, ntfy: { ...cur.ntfy, topic: newTopic } };
  writeSecrets(next);
  console.log('✓ secrets.json updated.');
  console.log('');
  console.log('Next steps on your phone:');
  console.log(`  1. ntfy app → Subscribe to topic → ${newTopic}`);
  console.log('  2. Unsubscribe from the old topic.');
  console.log('Then restart the daemon:  npm run cockpit');
}
