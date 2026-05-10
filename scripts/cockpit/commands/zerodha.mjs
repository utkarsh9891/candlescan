/**
 * `cockpit zerodha` — interactive Zerodha Kite Connect credential setup.
 *
 * Stores: apiKey, apiSecret (hidden), accessToken (hidden, daily-rotated).
 * If a gate is set, apiSecret + accessToken are encrypted at rest.
 *
 * Subcommands:
 *   cockpit zerodha               set/update creds
 *   cockpit zerodha access-token  update only the daily access token
 *   cockpit zerodha show          show stored fields (redacted)
 *   cockpit zerodha clear         remove all Zerodha creds
 */

import { ask, askSecret, confirm } from '../lib/prompts.mjs';
import { readSecrets, writeSecrets } from '../lib/secrets-rw.mjs';
import { encrypt, deriveKey, verifyPassphrase, isEncrypted } from '../lib/gate.mjs';

export const help = `
cockpit zerodha [access-token | show | clear] — manage Zerodha credentials

  cockpit zerodha               interactive setup of API key + secret + token
  cockpit zerodha access-token  rotate only the daily access token
  cockpit zerodha show          show stored fields (redacted)
  cockpit zerodha clear         remove all Zerodha creds from secrets.json

Zerodha access tokens expire daily (~06:00 IST). Use 'access-token' each
morning rather than re-running the full setup. If a gate is set, apiSecret
and accessToken are encrypted at rest.
`.trim();

export async function run(args) {
  const sub = args[0];
  if (sub === 'show') return show();
  if (sub === 'clear') return clear();
  if (sub === 'access-token') return rotateAccessToken();
  return setAll();
}

async function setAll() {
  const cur = readSecrets();
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

  let secretValue = apiSecret;
  let tokenValue = accessToken;
  if (cur.gate?.salt) {
    console.log('\ngate is set — apiSecret + accessToken will be encrypted at rest.');
    const passphrase = await askSecret('passphrase to unlock gate');
    if (!verifyPassphrase(cur.gate, passphrase)) {
      console.log('✗ wrong passphrase — aborting.');
      return;
    }
    const key = deriveKey(cur.gate, passphrase);
    secretValue = encrypt(apiSecret, key);
    if (accessToken) tokenValue = encrypt(accessToken, key);
  }

  const next = {
    ...cur,
    zerodha: {
      apiKey: apiKey.trim(),
      apiSecret: secretValue,
      accessToken: accessToken ? tokenValue : undefined,
    },
  };
  if (!next.zerodha.accessToken) delete next.zerodha.accessToken;

  writeSecrets(next);
  console.log('\n✓ Zerodha creds saved.');
  console.log('  rotate access token each morning:  npm run cockpit:zerodha access-token');
}

async function rotateAccessToken() {
  const cur = readSecrets();
  if (!cur.zerodha?.apiKey) {
    console.log('no Zerodha config — run:  npm run cockpit:zerodha');
    return;
  }
  const accessToken = await askSecret('new Access Token (hidden)', {
    minLength: 16,
  });

  let tokenValue = accessToken;
  if (cur.gate?.salt) {
    const passphrase = await askSecret('passphrase to unlock gate');
    if (!verifyPassphrase(cur.gate, passphrase)) {
      console.log('✗ wrong passphrase — aborting.');
      return;
    }
    const key = deriveKey(cur.gate, passphrase);
    tokenValue = encrypt(accessToken, key);
  }

  const next = { ...cur, zerodha: { ...cur.zerodha, accessToken: tokenValue } };
  writeSecrets(next);
  console.log('✓ access token rotated.');
}

async function show() {
  const cur = readSecrets();
  const z = cur.zerodha;
  if (!z) {
    console.log('no Zerodha creds configured.');
    return;
  }
  console.log('Zerodha creds (redacted):');
  console.log(`  apiKey:      ${z.apiKey || '(unset)'}`);
  console.log(`  apiSecret:   ${z.apiSecret ? (isEncrypted(z.apiSecret) ? '<encrypted>' : '<' + z.apiSecret.length + '-char, redacted>') : '(unset)'}`);
  console.log(`  accessToken: ${z.accessToken ? (isEncrypted(z.accessToken) ? '<encrypted>' : '<' + z.accessToken.length + '-char, redacted>') : '(unset)'}`);
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
