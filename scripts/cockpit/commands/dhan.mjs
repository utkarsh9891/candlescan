/**
 * `cockpit dhan` — interactive Dhan credential setup.
 *
 * Stores: clientId, partnerId (optional), pin (encrypted at rest via
 * the cockpit gate — gate is REQUIRED, the set path refuses to write
 * plain creds).
 * NOT stored: TOTP — that's a 30-second time-based code; the cockpit
 * prompts for it interactively at daemon launch when Dhan is configured.
 *
 * Subcommands:
 *   cockpit dhan          set/update creds (REQUIRES `cockpit:gate set` first)
 *   cockpit dhan show     show stored fields (redacted summary; works without gate)
 *   cockpit dhan clear    remove all Dhan creds (works without gate)
 */

import { ask, askSecret, confirm } from '../lib/prompts.mjs';
import { readSecrets, writeSecrets } from '../lib/secrets-rw.mjs';
import {
  verifyPassphrase,
  deriveKey,
  encryptSensitive,
  isEncrypted,
} from '../lib/gate.mjs';

export const help = `cockpit dhan [show | clear] — manage Dhan broker credentials

  cockpit dhan          interactive setup of clientId + PIN
                        (REQUIRES cockpit gate to be set first)
  cockpit dhan show     show stored fields (redacted summary)
  cockpit dhan clear    remove all Dhan creds from secrets.json

PIN is encrypted at rest via the cockpit gate (PBKDF2 + AES-256-GCM).
The set path refuses to run if no gate is configured — set one first:
  npm run cockpit:gate -- set

TOTP is never stored — it's prompted at daemon launch.`;

export async function run(args) {
  const sub = args[0];
  if (sub === 'show') return show();
  if (sub === 'clear') return clear();
  return setCreds();
}

async function setCreds() {
  const cur = readSecrets();

  // Gate is REQUIRED for storing broker creds. Fail fast before
  // prompting for any sensitive input — no point asking for the PIN if
  // we're going to refuse to write it anyway.
  if (!cur.gate?.salt) {
    console.error('✗ Dhan creds cannot be stored without a cockpit gate.');
    console.error('  Broker credentials must be encrypted at rest.');
    console.error('');
    console.error('  Set a gate first:  npm run cockpit:gate -- set');
    console.error('  Then re-run:       npm run cockpit:dhan');
    process.exit(1);
  }

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

  const next = {
    ...cur,
    dhan: {
      clientId: clientId.trim(),
      partnerId: partnerId.trim() || undefined,
      pin,
    },
  };
  if (!next.dhan.partnerId) delete next.dhan.partnerId;

  const finalState = await encryptWithGate(next);
  if (!finalState) return; // wrong passphrase, abort
  writeSecrets(finalState);
  console.log('\n✓ Dhan creds saved (PIN encrypted at rest).');
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
    const tag = isEncrypted(d.pin) ? '<encrypted at rest>' : `<${d.pin.length}-digit, plain>`;
    console.log(`  pin:       ${tag}`);
  } else {
    console.log('  pin:       (unset)');
  }
  // Cached access token from previous boot's TOTP login (populated at
  // daemon runtime, not by this command).
  if (d.accessToken) {
    const tag = isEncrypted(d.accessToken) ? '<encrypted at rest>' : `<${d.accessToken.length}-char, plain>`;
    let exp = '(no expiry recorded)';
    if (typeof d.accessTokenExpiresAt === 'number') {
      const nowSec = Math.floor(Date.now() / 1000);
      const minsLeft = Math.floor((d.accessTokenExpiresAt - nowSec) / 60);
      const iso = new Date(d.accessTokenExpiresAt * 1000).toISOString();
      exp = minsLeft > 0 ? `${iso} (${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m left)` : `${iso} (expired)`;
    }
    console.log(`  accessToken: ${tag}`);
    console.log(`    expires:   ${exp}`);
  } else {
    console.log(`  accessToken: (not yet cached — runs at first cockpit:start with TOTP)`);
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
 * Verify the gate passphrase, derive the key, encrypt the cfg's
 * sensitive fields. Caller has already confirmed the gate exists.
 * Returns the cfg ready to write, or null if the passphrase was wrong.
 */
async function encryptWithGate(nextCfg) {
  console.log('\nGate is set — PIN will be encrypted at rest.');
  const passphrase = await askSecret('passphrase to unlock gate');
  if (!verifyPassphrase(nextCfg.gate, passphrase)) {
    console.log('✗ wrong passphrase — aborting.');
    return null;
  }
  const key = deriveKey(nextCfg.gate, passphrase);
  return encryptSensitive(nextCfg, key);
}
