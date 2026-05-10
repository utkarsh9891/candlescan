/**
 * `cockpit dhan` — interactive Dhan credential setup.
 *
 * Stores: clientId, partnerId (optional), pin (hidden, encrypted at rest
 * if a cockpit gate is set).
 * NOT stored: TOTP — that's a 30-second time-based code; the cockpit
 * prompts for it interactively at daemon launch when Dhan is configured.
 *
 * Subcommands:
 *   cockpit dhan          set/update creds
 *   cockpit dhan show     show stored fields (redacted summary)
 *   cockpit dhan clear    remove all Dhan creds
 *
 * If a gate is set (`cockpit:gate set`), this command requires the
 * passphrase to encrypt the PIN before writing.
 */

import { ask, askSecret, confirm } from '../lib/prompts.mjs';
import { readSecrets, writeSecrets } from '../lib/secrets-rw.mjs';
import {
  verifyPassphrase,
  deriveKey,
  encryptSensitive,
  isEncrypted,
} from '../lib/gate.mjs';

export const help = `
cockpit dhan [show | clear] — manage Dhan broker credentials

  cockpit dhan          interactive setup of clientId + PIN
  cockpit dhan show     show stored fields (redacted summary)
  cockpit dhan clear    remove all Dhan creds from secrets.json

PIN is stored. TOTP is NOT stored — it's prompted at daemon launch.
If a gate is set (cockpit:gate set), PIN is encrypted at rest.
`.trim();

export async function run(args) {
  const sub = args[0];
  if (sub === 'show') return show();
  if (sub === 'clear') return clear();
  return setCreds();
}

async function setCreds() {
  const cur = readSecrets();
  const dhan = cur.dhan || {};
  console.log('Dhan credential setup\n');

  const clientId = await ask('Dhan Client ID', {
    defaultValue: dhan.clientId || '',
    required: true,
  });

  const partnerId = await ask('Partner ID (optional, press Enter to skip)', {
    defaultValue: dhan.partnerId || '',
  });

  const pin = await askSecret('Dhan PIN (4–6 digits)', {
    confirm: true,
    minLength: 4,
  });

  // Build the unencrypted next state, then run encryptSensitive() if a
  // gate is set. encryptSensitive() walks the ENCRYPTED_PATHS list —
  // PIN is included, ntfy + zerodha encrypted fields stay encrypted
  // (we re-encrypt them too, which is idempotent).
  const next = {
    ...cur,
    dhan: {
      clientId: clientId.trim(),
      partnerId: partnerId.trim() || undefined,
      pin,
    },
  };
  if (!next.dhan.partnerId) delete next.dhan.partnerId;

  const finalState = await applyGate(next, cur);
  if (!finalState) return; // wrong passphrase, abort
  writeSecrets(finalState);
  console.log('\n✓ Dhan creds saved.');
  console.log('  TOTP is prompted at  npm run cockpit:start  launch (interactive only).');
}

async function show() {
  const cur = readSecrets();
  const d = cur.dhan;
  if (!d) {
    console.log('no Dhan creds configured.');
    return;
  }
  console.log('Dhan creds:');
  console.log(`  clientId:  ${d.clientId || '(unset)'}`);
  if (d.partnerId) console.log(`  partnerId: ${d.partnerId}`);
  if (d.pin) {
    const tag = isEncrypted(d.pin) ? '<encrypted at rest>' : `<${d.pin.length}-digit, hidden>`;
    console.log(`  pin:       ${tag}`);
  } else {
    console.log('  pin:       (unset)');
  }
}

async function clear() {
  const cur = readSecrets();
  if (!cur.dhan) {
    console.log('nothing to clear.');
    return;
  }
  const ok = await confirm('Remove ALL Dhan credentials?', false);
  if (!ok) {
    console.log('aborted.');
    return;
  }
  const next = { ...cur };
  delete next.dhan;
  writeSecrets(next);
  console.log('✓ Dhan creds cleared.');
}

/**
 * If a gate is set, ask for passphrase, derive key, run encryptSensitive
 * on the new cfg. Returns the cfg ready to write, or null if the user
 * entered the wrong passphrase.
 */
async function applyGate(nextCfg, _cur) {
  if (!nextCfg.gate?.salt) return nextCfg;
  console.log('\ngate is set — PIN will be encrypted at rest.');
  const passphrase = await askSecret('passphrase to unlock gate');
  if (!verifyPassphrase(nextCfg.gate, passphrase)) {
    console.log('✗ wrong passphrase — aborting.');
    return null;
  }
  const key = deriveKey(nextCfg.gate, passphrase);
  return encryptSensitive(nextCfg, key);
}
