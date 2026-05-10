/**
 * Cockpit config: defaults merged with ~/.candlescan/cockpit/secrets.json.
 *
 * Secrets file lives outside the repo (gitignored at the OS level) and is
 * stored mode 0600 by the management CLI commands. Schema:
 *   {
 *     "host":    { "name": "cockpit.local", "port": 5174 },
 *     "ntfy":    { "topic": "candlescan-<random>", "server": "https://ntfy.sh" },
 *     "scan":    { "engine": "intraday", "index": "NIFTY 50",
 *                  "intervalSec": 60, "minConfidence": 75, "timeframe": "5m" },
 *     "exit":    { "intervalSec": 30 },
 *     "dhan":    { "clientId": "...", "pin": "..." },
 *     "zerodha": { "apiKey": "...", "apiSecret": "...", "accessToken": "..." }
 *   }
 *
 * Only ntfy.topic + host fields are required. Broker creds are forward-
 * looking — the scan path currently uses anonymous Yahoo and does not
 * read them.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
        `See scripts/cockpit/README.md (or run: npm run cockpit:init).`,
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
