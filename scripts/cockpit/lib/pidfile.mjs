/**
 * Pidfile management for the cockpit daemon.
 *
 * On boot:
 *   - If the pid file exists AND the process is alive → refuse to start
 *     (another cockpit is running; user runs `cockpit:stop` first).
 *   - If the pid file exists but the process is gone → stale, clean up
 *     and proceed.
 *   - Write our own pid.
 *
 * On shutdown: remove the pid file (best-effort; SIGKILL leaves it
 * behind, which the next boot will clean up as stale).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PID_FILE = path.join(os.homedir(), '.candlescan', 'cockpit', 'cockpit.pid');

export function pidFilePath() {
  return PID_FILE;
}

export function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0: existence check, no-op if alive
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but we can't signal
  }
}

export function readPidFile() {
  if (!fs.existsSync(PID_FILE)) return null;
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function writePidFile(pid) {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(pid));
}

export function removePidFile() {
  try { fs.unlinkSync(PID_FILE); } catch { /* already gone */ }
}

/**
 * Boot guard. Throws if another cockpit appears to be running. Cleans
 * up a stale file and writes the new pid otherwise.
 */
export function claimPidFile() {
  const existing = readPidFile();
  if (existing !== null && isPidAlive(existing)) {
    const err = new Error(
      `another cockpit appears to be running (pid ${existing}). ` +
        `Stop it first:  npm run cockpit:stop`,
    );
    err.code = 'EALREADYRUNNING';
    throw err;
  }
  if (existing !== null) {
    // Stale — process is gone, file lingered.
    removePidFile();
  }
  writePidFile(process.pid);
}
