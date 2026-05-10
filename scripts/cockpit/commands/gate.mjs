/**
 * `cockpit gate` — manage the optional passphrase that encrypts sensitive
 * fields in secrets.json (ntfy topic, Dhan PIN, Zerodha apiSecret +
 * accessToken).
 *
 * The gate is a defense against backups and casual snooping. mode 0600
 * stops other Unix users; the gate stops Time Machine, iCloud sync, and
 * `cat secrets.json` from yielding plain creds.
 *
 * Subcommands:
 *   cockpit gate                show status (set / not set)
 *   cockpit gate set            set or change the passphrase
 *   cockpit gate clear          remove the gate (decrypts secrets back to plain)
 *   cockpit gate test           verify a passphrase without changing state
 *
 * Once a gate is set, `npm run cockpit:start` prompts for the passphrase
 * at startup (max 3 attempts). The cockpit launches manually anyway —
 * no auto-start infrastructure to clash with — so this is just an extra
 * step in your morning startup.
 */

import { askSecret, confirm } from '../lib/prompts.mjs';
import { readSecrets, writeSecrets } from '../lib/secrets-rw.mjs';
import {
  makeGateConfig,
  verifyPassphrase,
  deriveKey,
  encryptSensitive,
  decryptSensitive,
} from '../lib/gate.mjs';

export const help = `
cockpit gate <set | clear | test | status>

Optional passphrase that encrypts ntfy topic + Dhan PIN + Zerodha
apiSecret/accessToken at rest in secrets.json. Defends against:
  - Time Machine + iCloud + Dropbox backups copying the file
  - Other processes / shoulder-surfing reading the file
  - Mode 0600 alone doesn't help against any of those.

Once set, the daemon prompts for the passphrase at startup (max 3 attempts).

  cockpit gate         show status (default)
  cockpit gate set     set or change the passphrase
  cockpit gate clear   remove the gate (decrypts secrets back to plain)
  cockpit gate test    verify a passphrase without changing anything
`.trim();

export async function run(args) {
  const sub = args[0];
  if (sub === 'set' || sub === 'change') return setGate();
  if (sub === 'clear' || sub === 'remove') return clearGate();
  if (sub === 'test' || sub === 'verify') return testGate();
  if (sub === 'status' || !sub) return statusGate();
  console.log(`unknown subcommand: ${sub}`);
  console.log(help);
}

async function statusGate() {
  const cur = readSecrets();
  if (cur.gate?.salt) {
    console.log('gate: SET');
    console.log(`  algo: ${cur.gate.algo}, iterations: ${cur.gate.iterations}`);
  } else {
    console.log('gate: NOT SET');
    console.log('  (sensitive fields stored plain; secrets.json is mode 0600)');
  }
}

async function setGate() {
  const cur = readSecrets();
  const isChange = !!cur.gate?.salt;

  if (isChange) {
    console.log('changing existing gate — current passphrase needed first.');
    const oldPass = await askSecret('current passphrase');
    if (!verifyPassphrase(cur.gate, oldPass)) {
      console.log('✗ wrong passphrase — aborting.');
      return;
    }
    const oldKey = deriveKey(cur.gate, oldPass);
    const decrypted = decryptSensitive(cur, oldKey);

    const newPass = await askSecret('new passphrase', { confirm: true, minLength: 8 });
    const newGate = makeGateConfig(newPass);
    const newKey = deriveKey(newGate, newPass);
    const next = { ...decrypted, gate: newGate };
    const encrypted = encryptSensitive(next, newKey);

    writeSecrets(encrypted);
    console.log('✓ gate passphrase changed (existing secrets re-encrypted).');
    return;
  }

  console.log('Setting a new gate. Pick a passphrase you can remember — losing it');
  console.log('means re-running cockpit:dhan / cockpit:zerodha / cockpit:rotate-topic');
  console.log('to re-enter every encrypted field.\n');
  const pass = await askSecret('new passphrase', { confirm: true, minLength: 8 });
  const gateCfg = makeGateConfig(pass);
  const key = deriveKey(gateCfg, pass);
  const next = encryptSensitive({ ...cur, gate: gateCfg }, key);

  writeSecrets(next);
  console.log('✓ gate set; existing secrets encrypted.');
  console.log('  daemon will now prompt for passphrase at startup.');
}

async function clearGate() {
  const cur = readSecrets();
  if (!cur.gate?.salt) {
    console.log('no gate set.');
    return;
  }
  const pass = await askSecret('current passphrase');
  if (!verifyPassphrase(cur.gate, pass)) {
    console.log('✗ wrong passphrase — aborting.');
    return;
  }
  const ok = await confirm('Decrypt all secrets back to plain text and remove gate?', false);
  if (!ok) {
    console.log('aborted.');
    return;
  }
  const key = deriveKey(cur.gate, pass);
  const decrypted = decryptSensitive(cur, key);
  delete decrypted.gate;
  writeSecrets(decrypted);
  console.log('✓ gate cleared; secrets are plain text (file is still mode 0600).');
}

async function testGate() {
  const cur = readSecrets();
  if (!cur.gate?.salt) {
    console.log('no gate set.');
    return;
  }
  const pass = await askSecret('passphrase to test');
  if (verifyPassphrase(cur.gate, pass)) {
    console.log('✓ passphrase correct.');
  } else {
    console.log('✗ passphrase incorrect.');
    process.exit(1);
  }
}
