#!/usr/bin/env node
/**
 * cockpit CLI dispatcher.
 *
 * Usage:
 *   node scripts/cockpit/cli.mjs <command> [args]
 *   node scripts/cockpit/cli.mjs help [command]
 *
 * npm aliases:
 *   npm run cockpit:init         npm run cockpit:dhan         npm run cockpit:zerodha
 *   npm run cockpit:gate         npm run cockpit:rotate-topic npm run cockpit:status
 *   npm run cockpit:logs         npm run cockpit:config       npm run cockpit:help
 *
 * The daemon entrypoint is `scripts/cockpit/index.mjs` (run via
 * `npm run cockpit`). This file ONLY runs management commands; it does
 * NOT start the daemon, so any subcommand that completes returns control.
 */

import * as init from './commands/init.mjs';
import * as config from './commands/config.mjs';
import * as dhan from './commands/dhan.mjs';
import * as zerodha from './commands/zerodha.mjs';
import * as gate from './commands/gate.mjs';
import * as rotateTopic from './commands/rotate-topic.mjs';
import * as status from './commands/status.mjs';
import * as logs from './commands/logs.mjs';

const COMMANDS = {
  init,
  config,
  dhan,
  zerodha,
  gate,
  'rotate-topic': rotateTopic,
  status,
  logs,
};

const TOP_HELP = `
CandleScan Cockpit — management CLI

Usage:
  npm run cockpit                  Start the daemon (scan + exit-monitor + http)
  npm run cockpit:<cmd>            Run a management command
  node scripts/cockpit/cli.mjs <cmd> [args]   (direct invocation)
  node scripts/cockpit/cli.mjs help [cmd]     Show help for any command

Commands:
  init           First-run wizard — set ntfy topic + scan defaults
  config         Print current effective config (redacted)
  dhan           Manage Dhan broker creds (clientId + PIN; TOTP at boot)
  zerodha        Manage Zerodha Kite creds (apiKey + apiSecret + accessToken)
  gate           Manage optional passphrase that encrypts secret fields
  rotate-topic   Generate a new ntfy topic, notify the old, update secrets
  status         Show daemon health (secrets / HTTP / launchd / today's P&L)
  logs           Print or follow today's log file

Setup files:
  ~/.candlescan/cockpit/secrets.json       managed by these commands (mode 0600)
  ~/.candlescan/cockpit/state/<date>.json  signals + paper trades, per IST day
  ~/.candlescan/cockpit/logs/<date>.log    plain-text log mirror
`.trim();

export async function dispatch(argv) {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    const target = rest[0];
    if (target && COMMANDS[target]) {
      console.log(COMMANDS[target].help.trim());
      return;
    }
    if (target) {
      console.log(`unknown command: ${target}`);
      console.log(TOP_HELP);
      return;
    }
    console.log(TOP_HELP);
    return;
  }

  // Honor --help on any subcommand: `cockpit dhan --help` etc.
  if (rest.includes('--help') || rest.includes('-h')) {
    if (COMMANDS[cmd]) {
      console.log(COMMANDS[cmd].help.trim());
      return;
    }
  }

  const handler = COMMANDS[cmd];
  if (!handler) {
    console.error(`unknown command: ${cmd}\n`);
    console.error(TOP_HELP);
    process.exit(1);
  }

  try {
    await handler.run(rest);
  } catch (e) {
    console.error(`✗ ${cmd}: ${e.message}`);
    process.exit(1);
  }
}

// ESM main-module check
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  dispatch(process.argv.slice(2));
}
