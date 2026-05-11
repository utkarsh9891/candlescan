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
import * as keychain from '../lib/keychain.mjs';

export const help = `
cockpit gate <set | clear | test | status | cache | uncache>

Passphrase that encrypts ntfy topic + Dhan PIN + Dhan access token +
Zerodha apiSecret + Zerodha access token at rest in secrets.json.
Required for storing broker creds. Defends against backups, sync,
shoulder-surfing — mode 0600 alone doesn't.

  cockpit gate           show status (default)
  cockpit gate set       set or change the passphrase
  cockpit gate clear     remove the gate (decrypts secrets back to plain)
  cockpit gate test      verify a passphrase without changing state
  cockpit gate cache     cache the passphrase in macOS Keychain so the
                         daemon reads it at boot — skips the typed prompt
  cockpit gate uncache   remove the cached passphrase from macOS Keychain
`.trim();

export async function run(args) {
  const sub = args[0];
  if (sub === 'set' || sub === 'change') return setGate();
  if (sub === 'clear' || sub === 'remove') return clearGate();
  if (sub === 'test' || sub === 'verify') return testGate();
  if (sub === 'cache') return cacheToKeychain();
  if (sub === 'uncache') return uncacheFromKeychain();
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
  if (keychain.isAvailable()) {
    const cached = keychain.isCached();
    console.log(`keychain cache: ${cached ? 'PRESENT' : 'absent'} (service: ${keychain.serviceName()})`);
    if (cached) {
      console.log('  daemon will read the passphrase from Keychain at boot and skip the typed prompt.');
    }
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

async function cacheToKeychain() {
  if (!keychain.isAvailable()) {
    console.error('✗ macOS Keychain not available on this platform.');
    process.exit(1);
  }
  const cur = readSecrets();
  if (!cur.gate?.salt) {
    console.error('✗ no gate set — nothing to cache.');
    console.error('  Set one first:  npm run cockpit:gate -- set');
    process.exit(1);
  }
  console.log('Enter the gate passphrase. It will be verified, then stored in macOS Keychain');
  console.log('under service "' + keychain.serviceName() + '" so future cockpit:start boots');
  console.log('skip the passphrase prompt.');
  console.log('');
  const pass = await askSecret('passphrase');
  if (!verifyPassphrase(cur.gate, pass)) {
    console.error('✗ wrong passphrase — not caching.');
    process.exit(1);
  }
  if (keychain.setPassphrase(pass)) {
    console.log('✓ passphrase cached in macOS Keychain.');
    console.log('  First boot may pop a "node wants access" dialog — click "Always Allow"');
    console.log('  (Touch ID confirms) to skip future prompts.');
  } else {
    console.error('✗ Keychain write failed.');
    process.exit(1);
  }
}

async function uncacheFromKeychain() {
  if (!keychain.isAvailable()) {
    console.error('✗ macOS Keychain not available on this platform.');
    process.exit(1);
  }
  if (!keychain.isCached()) {
    console.log('nothing cached — already uncached.');
    return;
  }
  if (keychain.deletePassphrase()) {
    console.log('✓ cached passphrase removed from macOS Keychain.');
    console.log('  Next cockpit:start will prompt for the passphrase again.');
  } else {
    console.error('✗ Keychain delete failed.');
    process.exit(1);
  }
}
