/**
 * Atomic read + write of ~/.candlescan/cockpit/secrets.json.
 *
 * Writes go through a temp file + rename so a crash mid-write can't
 * corrupt the file. Mode is forced to 0600 on every write so the file
 * is never world-readable even if the user changed perms.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SECRETS_PATH = path.join(os.homedir(), '.candlescan', 'cockpit', 'secrets.json');

export function secretsPath() {
  return SECRETS_PATH;
}

export function exists() {
  return fs.existsSync(SECRETS_PATH);
}

export function readSecrets() {
  if (!fs.existsSync(SECRETS_PATH)) return {};
  return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
}

export function writeSecrets(obj) {
  fs.mkdirSync(path.dirname(SECRETS_PATH), { recursive: true });
  const tmp = SECRETS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SECRETS_PATH);
  try {
    fs.chmodSync(SECRETS_PATH, 0o600);
  } catch {
    /* best-effort */
  }
}

export function updateSecrets(mutator) {
  const cur = readSecrets();
  const next = mutator({ ...cur }) ?? cur;
  writeSecrets(next);
  return next;
}
