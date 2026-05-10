/**
 * Cockpit config: defaults merged with ~/.candlescan/cockpit/secrets.json.
 *
 * Secrets file lives outside the repo (gitignored at the OS level).
 * Schema:
 * {
 *   "host":    { "name": "cockpit.local", "port": 5174 },
 *   "ntfy":    { "topic": "candlescan-<random>", "server": "https://ntfy.sh" },
 *   "scan":    { "engine": "intraday", "index": "NIFTY 50",
 *                "intervalSec": 60, "minConfidence": 75, "timeframe": "5m" },
 *   "dhan":    { "clientId": "...", "accessToken": "...", "tokenExpiresAt": "..." },
 *   "zerodha": { "apiKey": "...",   "accessToken": "..." }
 * }
 *
 * Only ntfy.topic is required. Broker creds are optional until Day 2 wires
 * them into the live fetcher; absence falls through to anonymous Yahoo.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  verifyPassphrase,
  deriveKey,
  decrypt,
  isEncrypted,
  mapStrings,
} from './lib/gate.mjs';
import { askSecret } from './lib/prompts.mjs';

const SECRETS_PATH = path.join(os.homedir(), '.candlescan', 'cockpit', 'secrets.json');

const DEFAULTS = {
  host: { name: 'cockpit.local', port: 5174 },
  ntfy: { topic: null, server: 'https://ntfy.sh' },
  scan: {
    engine: 'intraday',
    index: 'NIFTY 50',
    intervalSec: 60,
    minConfidence: 75,
    timeframe: '5m',
  },
  dhan: null,
  zerodha: null,
};

function isObj(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  if (override == null) return base;
  if (!isObj(base) || !isObj(override)) return override;
  const out = { ...base };
  for (const k of Object.keys(override)) {
    out[k] = deepMerge(base[k], override[k]);
  }
  return out;
}

export function loadConfig() {
  let secrets = {};
  if (fs.existsSync(SECRETS_PATH)) {
    try {
      secrets = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
    } catch (e) {
      throw new Error(`failed to parse ${SECRETS_PATH}: ${e.message}`);
    }
  } else {
    throw new Error(
      `${SECRETS_PATH} not found. ` +
        `See scripts/cockpit/README.md for first-run setup.`,
    );
  }
  const cfg = deepMerge(DEFAULTS, secrets);
  validate(cfg);
  return cfg;
}

function validate(cfg) {
  if (!cfg.ntfy?.topic) {
    throw new Error(`ntfy.topic missing in ${SECRETS_PATH}`);
  }
  if (!cfg.host?.name || !cfg.host?.port) {
    throw new Error(`host.name and host.port required in ${SECRETS_PATH}`);
  }
}

export function secretsPath() {
  return SECRETS_PATH;
}

export function baseUrl(cfg) {
  return `http://${cfg.host.name}:${cfg.host.port}`;
}

/**
 * Like loadConfig() but additionally:
 *   - if a gate is set, prompts the user for the passphrase
 *   - decrypts cfg.dhan + cfg.zerodha string fields in-place (in memory only)
 *   - errors out clearly if gate is set + stdin is not a TTY (launchd case)
 *
 * Use this from interactive entrypoints (the daemon). Management commands
 * that just edit the file should use loadConfig() — they handle gate
 * verification themselves where they need it.
 */
export async function loadConfigInteractive() {
  const cfg = loadConfig();
  if (!cfg.gate?.salt) return cfg;

  if (!process.stdin.isTTY) {
    throw new Error(
      'gate is set but stdin is not a TTY. Run the daemon interactively ' +
        '(npm run cockpit) or remove the gate (npm run cockpit:gate -- clear).',
    );
  }

  process.stdout.write('\nGate is set — passphrase required to decrypt broker creds.\n');
  for (let attempts = 0; attempts < 3; attempts++) {
    const pass = await askSecret('passphrase');
    if (verifyPassphrase(cfg.gate, pass)) {
      const key = deriveKey(cfg.gate, pass);
      if (cfg.dhan) cfg.dhan = mapStrings(cfg.dhan, (v) => isEncrypted(v) ? decrypt(v, key) : v);
      if (cfg.zerodha) cfg.zerodha = mapStrings(cfg.zerodha, (v) => isEncrypted(v) ? decrypt(v, key) : v);
      return cfg;
    }
    process.stdout.write(`  ✗ wrong passphrase (${attempts + 1}/3)\n`);
  }
  throw new Error('passphrase verification failed after 3 attempts');
}
