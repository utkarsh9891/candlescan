/**
 * `cockpit gate` — manage the optional passphrase that encrypts sensitive
 * fields in secrets.json (Dhan PIN, Zerodha apiSecret + accessToken).
 *
 * Subcommands:
 *   cockpit gate set    set / change the passphrase (re-encrypts existing secrets)
 *   cockpit gate clear  remove the gate (decrypts secrets back to plain text)
 *   cockpit gate test   verify a passphrase without changing anything
 *   cockpit gate status show whether a gate is set
 *
 * Once a gate is set, the daemon (`npm run cockpit`) prompts for the
 * passphrase at startup — non-interactive launchd-started cockpits will
 * fail with a clear message if a gate is set.
 */

import { askSecret, confirm } from '../lib/prompts.mjs';
import { readSecrets, writeSecrets } from '../lib/secrets-rw.mjs';
import {
  makeGateConfig,
  verifyPassphrase,
  deriveKey,
  encrypt,
  decrypt,
  isEncrypted,
  mapStrings,
} from '../lib/gate.mjs';

export const help = `
cockpit gate <set | clear | test | status>

Optional passphrase that encrypts Dhan PIN + Zerodha apiSecret/accessToken.
Once set, the daemon prompts for the passphrase at startup. Launchd-started
cockpits cannot prompt — leave the gate unset if you rely on auto-start.

  cockpit gate set     set / change the passphrase
  cockpit gate clear   remove the gate (decrypt secrets back to plain)
  cockpit gate test    verify a passphrase without changing state
  cockpit gate status  print whether a gate is currently set
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
    console.log('gate: NOT SET (sensitive fields are stored plain in secrets.json — file mode 0600)');
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
    // Decrypt all encrypted fields with the old key, then re-encrypt with new.
    const oldKey = deriveKey(cur.gate, oldPass);

    const newPass = await askSecret('new passphrase', { confirm: true, minLength: 8 });
    const newGate = makeGateConfig(newPass);
    const newKey = deriveKey(newGate, newPass);

    const next = { ...cur, gate: newGate };
    if (next.dhan) next.dhan = mapStrings(next.dhan, (v) => isEncrypted(v) ? encrypt(decrypt(v, oldKey), newKey) : v);
    if (next.zerodha) next.zerodha = mapStrings(next.zerodha, (v) => isEncrypted(v) ? encrypt(decrypt(v, oldKey), newKey) : v);

    writeSecrets(next);
    console.log('✓ gate passphrase changed (existing secrets re-encrypted).');
    return;
  }

  console.log('Setting a new gate. Pick a passphrase you can remember — losing it');
  console.log('means you must re-enter Dhan PIN + Zerodha creds from scratch.\n');
  const pass = await askSecret('new passphrase', { confirm: true, minLength: 8 });
  const gateCfg = makeGateConfig(pass);
  const key = deriveKey(gateCfg, pass);

  const next = { ...cur, gate: gateCfg };
  // Encrypt any pre-existing PIN / apiSecret / accessToken now.
  if (next.dhan?.pin && !isEncrypted(next.dhan.pin)) {
    next.dhan = { ...next.dhan, pin: encrypt(next.dhan.pin, key) };
  }
  if (next.zerodha?.apiSecret && !isEncrypted(next.zerodha.apiSecret)) {
    next.zerodha = { ...next.zerodha, apiSecret: encrypt(next.zerodha.apiSecret, key) };
  }
  if (next.zerodha?.accessToken && !isEncrypted(next.zerodha.accessToken)) {
    next.zerodha = { ...next.zerodha, accessToken: encrypt(next.zerodha.accessToken, key) };
  }

  writeSecrets(next);
  console.log('✓ gate set; existing secrets encrypted.');
  console.log('  daemon will now prompt for passphrase at startup.');
  console.log('  ⚠ launchd auto-start will not work while a gate is set (no TTY).');
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
  const next = { ...cur };
  if (next.dhan) next.dhan = mapStrings(next.dhan, (v) => isEncrypted(v) ? decrypt(v, key) : v);
  if (next.zerodha) next.zerodha = mapStrings(next.zerodha, (v) => isEncrypted(v) ? decrypt(v, key) : v);
  delete next.gate;
  writeSecrets(next);
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
