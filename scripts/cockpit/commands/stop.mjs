/**
 * `cockpit stop` — send SIGTERM to the running cockpit daemon.
 *
 * Reads the pid from ~/.candlescan/cockpit/cockpit.pid (written by the
 * daemon at boot). Sends SIGTERM, waits up to 5s for graceful shutdown
 * (HTTP server close + state flush), escalates to SIGKILL if it
 * doesn't exit. Removes the pid file when done.
 */

import {
  pidFilePath,
  isPidAlive,
  readPidFile,
  removePidFile,
} from '../lib/pidfile.mjs';

export const help = `
cockpit stop — gracefully stop the running cockpit daemon

Reads the pid from the file the daemon wrote at boot, sends SIGTERM,
waits up to 5 seconds for graceful shutdown, then escalates to SIGKILL
if it hasn't exited. Removes the pid file.
`.trim();

export async function run() {
  const pid = readPidFile();
  if (pid === null) {
    console.log('cockpit not running (no pid file).');
    return;
  }
  if (!isPidAlive(pid)) {
    console.log(`stale pid file (pid ${pid} not running) — cleaning up.`);
    removePidFile();
    return;
  }

  console.log(`stopping cockpit (pid ${pid})...`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    console.error(`failed to send SIGTERM to ${pid}: ${e.message}`);
    process.exit(1);
  }

  // Wait up to 5s for graceful shutdown (200ms × 25 polls).
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (!isPidAlive(pid)) {
      console.log(`✓ cockpit stopped.`);
      removePidFile();
      return;
    }
  }

  console.log('graceful shutdown timed out — sending SIGKILL.');
  try {
    process.kill(pid, 'SIGKILL');
  } catch (e) {
    console.error(`SIGKILL failed: ${e.message}`);
    process.exit(1);
  }
  // Give the kernel a beat.
  await new Promise((r) => setTimeout(r, 200));
  if (isPidAlive(pid)) {
    console.error(`✗ pid ${pid} still alive after SIGKILL — something is wrong.`);
    console.error(`  pid file: ${pidFilePath()}`);
    process.exit(1);
  }
  removePidFile();
  console.log('✓ cockpit force-killed.');
}
