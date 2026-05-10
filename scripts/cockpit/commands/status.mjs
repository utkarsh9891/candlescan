/**
 * `cockpit status` — show cockpit health.
 *
 * Checks:
 *   - secrets.json present + key fields filled
 *   - HTTP server reachable on cfg.host (cockpit currently running?)
 *   - launchd job loaded?
 *   - today's signal + trade count from the state file
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readSecrets, exists, secretsPath } from '../lib/secrets-rw.mjs';

export const help = `
cockpit status — quick health summary

Checks secrets file, daemon reachability (HTTP /healthz), launchd
registration, and today's state file. No side effects.
`.trim();

const STATE_DIR = path.join(os.homedir(), '.candlescan', 'cockpit', 'state');
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function todayIst() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export async function run() {
  console.log('CandleScan Cockpit — status\n');

  // ── 1. secrets.json ──
  if (!exists()) {
    console.log(`✗ secrets:  not found at ${secretsPath()}`);
    console.log('  run:  npm run cockpit:init');
    return;
  }
  const cur = readSecrets();
  const ok = !!cur.ntfy?.topic && !!cur.host?.name;
  console.log(`${ok ? '✓' : '✗'} secrets:  ${secretsPath()}`);
  console.log(`    engine=${cur.scan?.engine || '?'} index="${cur.scan?.index || '?'}" tf=${cur.scan?.timeframe || '?'} conf>=${cur.scan?.minConfidence ?? '?'}`);
  if (cur.gate?.salt) console.log(`    gate:  SET (${cur.gate.algo})`);
  if (cur.dhan?.clientId) console.log(`    dhan:  configured (clientId=${cur.dhan.clientId})`);
  if (cur.zerodha?.apiKey) console.log(`    zerodha: configured (apiKey=${cur.zerodha.apiKey.slice(0, 6)}…)`);

  // ── 2. HTTP reachability ──
  const url = `http://${cur.host.name}:${cur.host.port}/healthz`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      console.log(`✓ daemon:   reachable at ${url}`);
    } else {
      console.log(`✗ daemon:   ${url} → HTTP ${res.status}`);
    }
  } catch (e) {
    console.log(`✗ daemon:   ${url} unreachable (${e.message.split('\n')[0]})`);
    console.log('    start with:  npm run cockpit');
  }

  // ── 3. launchd ──
  const domain = `gui/${process.getuid()}`;
  try {
    const out = execSync(`launchctl print ${domain}/com.candlescan.cockpit`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const stateLine = out.split('\n').find((l) => l.trim().startsWith('state'));
    console.log(`✓ launchd:  registered (${stateLine?.trim() || 'state unknown'})`);
  } catch {
    console.log('· launchd:  not registered (run scripts/cockpit/launchd/install.sh to enable auto-start)');
  }

  // ── 4. today's state ──
  const day = todayIst();
  const stateFile = path.join(STATE_DIR, `${day}.json`);
  if (fs.existsSync(stateFile)) {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const open = (s.trades || []).filter((t) => t.status === 'open').length;
      const closed = (s.trades || []).filter((t) => t.status === 'closed').length;
      const netPnl = (s.trades || [])
        .filter((t) => t.status === 'closed')
        .reduce((a, t) => a + (t.netPnl || 0), 0);
      console.log(`✓ today:    ${day} · signals=${(s.signals || []).length} · open=${open} · closed=${closed} · netPnl=Rs ${Math.round(netPnl).toLocaleString('en-IN')}`);
    } catch (e) {
      console.log(`✗ today:    state file unreadable: ${e.message}`);
    }
  } else {
    console.log(`· today:    no state file yet for ${day}`);
  }
}
