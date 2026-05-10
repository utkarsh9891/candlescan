/**
 * `cockpit zerodha` — interactive Zerodha Kite Connect credential setup.
 *
 * Stores: apiKey, apiSecret (encrypted at rest via the cockpit gate),
 * accessToken (encrypted at rest, daily-rotated). Gate is REQUIRED —
 * the set + access-token paths refuse to write plain creds.
 *
 * Subcommands:
 *   cockpit zerodha               set/update creds  (REQUIRES gate)
 *   cockpit zerodha access-token  rotate only the daily access token (REQUIRES gate)
 *   cockpit zerodha show          show stored fields (redacted summary; works without gate)
 *   cockpit zerodha clear         remove all Zerodha creds (works without gate)
 */

import { ask, askSecret, confirm } from '../lib/prompts.mjs';
import { readSecrets, writeSecrets } from '../lib/secrets-rw.mjs';
import {
  verifyPassphrase,
  deriveKey,
  encryptSensitive,
  isEncrypted,
} from '../lib/gate.mjs';

export const help = `cockpit zerodha [access-token | show | clear] — manage Zerodha credentials

  cockpit zerodha               interactive setup of API key + secret + token
                                (REQUIRES cockpit gate to be set first)
  cockpit zerodha access-token  rotate only the daily access token
                                (REQUIRES cockpit gate to be set first)
  cockpit zerodha show          show stored fields (redacted summary)
  cockpit zerodha clear         remove all Zerodha creds from secrets.json

apiSecret + accessToken are encrypted at rest via the cockpit gate
(PBKDF2 + AES-256-GCM). The set + access-token paths refuse to run if
no gate is configured — set one first:
  npm run cockpit:gate -- set

Zerodha access tokens expire daily (~06:00 IST). Use \`access-token\`
each morning rather than re-running the full setup.`;

export async function run(args) {
  const sub = args[0];
  if (sub === 'show') return show();
  if (sub === 'clear') return clear();
  if (sub === 'access-token') return rotateAccessToken();
  return setAll();
}

/** Hard-fail if no gate is set. Both write paths call this first. */
function requireGate(cur) {
  if (cur.gate?.salt) return;
  console.error('✗ Zerodha creds cannot be stored without a cockpit gate.');
  console.error('  Broker credentials must be encrypted at rest.');
  console.error('');
  console.error('  Set a gate first:  npm run cockpit:gate -- set');
  console.error('  Then re-run:       npm run cockpit:zerodha');
  process.exit(1);
}

async function setAll() {
  const cur = readSecrets();
  requireGate(cur);

  const z = cur.zerodha || {};
  console.log('Zerodha Kite Connect credential setup\n');

  const apiKey = await ask('API Key', {
    defaultValue: z.apiKey || '',
    required: true,
  });
  const apiSecret = await askSecret('API Secret (hidden)', {
    confirm: false,
    minLength: 8,
  });
  const accessToken = await askSecret('Access Token (hidden, paste from Kite — daily-rotated)', {
    confirm: false,
    minLength: 16,
    required: false,
  });

  const next = {
    ...cur,
    zerodha: {
      apiKey: apiKey.trim(),
      apiSecret,
      accessToken: accessToken || undefined,
    },
  };
  if (!next.zerodha.accessToken) delete next.zerodha.accessToken;

  const finalState = await encryptWithGate(next);
  if (!finalState) return;
  writeSecrets(finalState);
  console.log('\n✓ Zerodha creds saved (apiSecret + accessToken encrypted at rest).');
  console.log('  rotate access token each morning:  npm run cockpit:zerodha -- access-token');
}

async function rotateAccessToken() {
  const cur = readSecrets();
  requireGate(cur);
  if (!cur.zerodha?.apiKey) {
    console.log('no Zerodha config — run:  npm run cockpit:zerodha');
    return;
  }
  const accessToken = await askSecret('new Access Token (hidden)', {
    minLength: 16,
  });

  const next = { ...cur, zerodha: { ...cur.zerodha, accessToken } };
  const finalState = await encryptWithGate(next);
  if (!finalState) return;
  writeSecrets(finalState);
  console.log('✓ access token rotated (encrypted at rest).');
}

async function show() {
  const cur = readSecrets();
  const z = cur.zerodha;
  if (!z) {
    console.log('no Zerodha creds configured.');
    return;
  }
  const tag = (v) => v ? (isEncrypted(v) ? '<encrypted at rest>' : `<${v.length}-char, plain>`) : '(unset)';
  console.log('Zerodha creds:');
  console.log(`  apiKey:      ${z.apiKey || '(unset)'}`);
  console.log(`  apiSecret:   ${tag(z.apiSecret)}`);
  console.log(`  accessToken: ${tag(z.accessToken)}`);
}

async function clear() {
  const cur = readSecrets();
  if (!cur.zerodha) {
    console.log('nothing to clear.');
    return;
  }
  const ok = await confirm('Remove ALL Zerodha credentials?', false);
  if (!ok) {
    console.log('aborted.');
    return;
  }
  const next = { ...cur };
  delete next.zerodha;
  writeSecrets(next);
  console.log('✓ Zerodha creds cleared.');
}

async function encryptWithGate(nextCfg) {
  console.log('\nGate is set — apiSecret + accessToken will be encrypted at rest.');
  const passphrase = await askSecret('passphrase to unlock gate');
  if (!verifyPassphrase(nextCfg.gate, passphrase)) {
    console.log('✗ wrong passphrase — aborting.');
    return null;
  }
  const key = deriveKey(nextCfg.gate, passphrase);
  return encryptSensitive(nextCfg, key);
}
