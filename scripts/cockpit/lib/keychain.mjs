/**
 * macOS Keychain integration for caching the cockpit gate passphrase.
 *
 * Wraps the built-in `security` CLI — no npm dep. Keychain items are
 * encrypted by macOS with your user account password, only readable by
 * your user, and Touch ID can unlock them.
 *
 * Item identity:
 *   service: candlescan-cockpit-gate
 *   account: $USER
 *
 * Security model:
 *   - The passphrase value is passed to `security add-generic-password`
 *     via the -w argument, which means it's briefly visible in `ps`
 *     output for the duration of the spawn. macOS only exposes ps args
 *     to the same user, so the practical exposure on a personal Mac is
 *     ~zero (anyone with access to your user account can already read
 *     ~/.candlescan/cockpit/secrets.json's verifier and try guesses).
 *   - On read, Keychain may prompt "node wants to access the keychain"
 *     the first time. Click "Always Allow" to skip future prompts.
 *
 * Falls through cleanly on non-macOS: `isAvailable()` returns false and
 * the caller falls back to passphrase prompting.
 */

import { spawnSync } from 'node:child_process';
import os from 'node:os';

const SERVICE = 'candlescan-cockpit-gate';
const ACCOUNT = os.userInfo().username || 'cockpit';

export function isAvailable() {
  if (process.platform !== 'darwin') return false;
  // `security` ships with macOS since 10.x — no need to probe the PATH.
  // We just verify a no-op call works in case PATH is somehow broken.
  const r = spawnSync('security', ['help'], { encoding: 'utf8' });
  return r.status === 0 || r.status === 1; // `security help` exits 1 but still proves it exists
}

export function serviceName() {
  return SERVICE;
}

/**
 * Add or replace the cached passphrase. Returns true on success.
 */
export function setPassphrase(passphrase) {
  // -U replaces the item if it already exists. -a/-s identify the item.
  // -w passes the password value (visible briefly in `ps`; see file
  // header for the threat-model note).
  const r = spawnSync(
    'security',
    ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', passphrase],
    { encoding: 'utf8' },
  );
  return r.status === 0;
}

/**
 * Returns the cached passphrase string, or null if no item / Keychain
 * locked / `security` errored. May trigger a macOS Keychain access
 * dialog on first call.
 */
export function getPassphrase() {
  const r = spawnSync(
    'security',
    ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return null;
  return (r.stdout || '').replace(/\n$/, '');
}

/**
 * Remove the cached passphrase. Returns true if it was deleted, false
 * if there was nothing to delete (or `security` errored).
 */
export function deletePassphrase() {
  const r = spawnSync(
    'security',
    ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT],
    { encoding: 'utf8' },
  );
  return r.status === 0;
}

export function isCached() {
  return getPassphrase() !== null;
}
