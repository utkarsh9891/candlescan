/**
 * `cockpit dhan` — interactive Dhan credential setup.
 *
 * Stores: clientId, partnerId (optional), pin (hidden, encrypted if gate set).
 * NOT stored: TOTP — that's a 30-second time-based code; cockpit prompts
 * for it interactively at daemon launch when Dhan is configured.
 *
 * Subcommands:
 *   cockpit dhan          set/update creds
 *   cockpit dhan show     show stored fields (redacted)
 *   cockpit dhan clear    remove all Dhan creds
 */

import { ask, askSecret, confirm } from '../lib/prompts.mjs';
import { readSecrets, writeSecrets } from '../lib/secrets-rw.mjs';
import { encrypt, deriveKey, verifyPassphrase, isEncrypted } from '../lib/gate.mjs';

export const help = `
cockpit dhan [show | clear] — manage Dhan broker credentials

  cockpit dhan          interactive setup of clientId + PIN
  cockpit dhan show     show stored fields (redacted)
  cockpit dhan clear    remove all Dhan creds from secrets.json

PIN is stored. TOTP is NOT stored — it's prompted at daemon launch.
If a gate is set (cockpit gate set), PIN is encrypted at rest.
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

  // If a gate exists, encrypt PIN. Otherwise plain (still 0600 file).
  let pinValue = pin;
  if (cur.gate?.salt) {
    console.log('\ngate is set — PIN will be encrypted at rest.');
    const passphrase = await askSecret('passphrase to unlock gate');
    if (!verifyPassphrase(cur.gate, passphrase)) {
      console.log('✗ wrong passphrase — aborting.');
      return;
    }
    const key = deriveKey(cur.gate, passphrase);
    pinValue = encrypt(pin, key);
  }

  const next = {
    ...cur,
    dhan: {
      clientId: clientId.trim(),
      partnerId: partnerId.trim() || undefined,
      pin: pinValue,
    },
  };
  // Drop undefined keys so JSON stays clean.
  if (!next.dhan.partnerId) delete next.dhan.partnerId;

  writeSecrets(next);
  console.log('\n✓ Dhan creds saved.');
  console.log('  TOTP is prompted at  npm run cockpit  launch (interactive only).');
}

async function show() {
  const cur = readSecrets();
  const d = cur.dhan;
  if (!d) {
    console.log('no Dhan creds configured.');
    return;
  }
  console.log('Dhan creds (redacted):');
  console.log(`  clientId:  ${d.clientId || '(unset)'}`);
  if (d.partnerId) console.log(`  partnerId: ${d.partnerId}`);
  if (d.pin) {
    console.log(`  pin:       ${isEncrypted(d.pin) ? '<encrypted>' : '<' + d.pin.length + '-digit, redacted>'}`);
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
