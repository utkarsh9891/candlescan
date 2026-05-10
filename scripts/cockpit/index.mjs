#!/usr/bin/env node
/**
 * CandleScan Cockpit — entry point.
 *
 * Spins up three concurrent loops:
 *   1. scan       — every cfg.scan.intervalSec, evaluate the index for signals
 *   2. exit-monitor — every cfg.exit.intervalSec (default 30s), check open trades
 *   3. http server — Hono on cfg.host.port serving the cockpit UI + API
 *
 * Logs to stdout (colored) and ~/.candlescan/cockpit/logs/<IST-date>.log.
 *
 * First-run: see scripts/cockpit/README.md
 */

import { loadConfig, baseUrl, secretsPath } from './config.mjs';
import { makeNtfyProvider, notify } from './notify.mjs';
import log from './log.mjs';
import { runScan } from './scan.mjs';
import { startServer, makeEventBus } from './lib/server.mjs';
import { runExitMonitor } from './lib/exit-monitor.mjs';
import { dispatch as dispatchCli } from './cli.mjs';

const DEFAULT_EXIT_INTERVAL_SEC = 30;

// Subcommand passthrough: `npm run cockpit init` etc. forwards to the CLI.
// No subcommand → boot the daemon (existing behavior).
const cliArgs = process.argv.slice(2);
if (cliArgs.length > 0) {
  dispatchCli(cliArgs).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    log.err(`fatal: ${e.message}`);
    process.exit(1);
  });
}

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    log.err(`config: ${e.message}`);
    log.boot(`first-run setup: scripts/cockpit/README.md  (or  npm run cockpit:init)`);
    log.boot(`secrets path: ${secretsPath()}`);
    process.exit(1);
  }

  log.boot(
    `cockpit start — engine=${cfg.scan.engine} index="${cfg.scan.index}" ` +
      `tf=${cfg.scan.timeframe} conf>=${cfg.scan.minConfidence} interval=${cfg.scan.intervalSec}s`,
  );
  log.boot(`host=${baseUrl(cfg)}`);

  const provider = makeNtfyProvider({
    server: cfg.ntfy.server,
    topic: cfg.ntfy.topic,
  });

  const eventBus = makeEventBus();

  // ── HTTP server ──
  const httpServer = startServer({ cfg, eventBus });

  // ── Boot notification ──
  await notify(provider, {
    title: 'Cockpit started',
    message:
      `engine=${cfg.scan.engine}  index="${cfg.scan.index}"\n` +
      `conf>=${cfg.scan.minConfidence}  every ${cfg.scan.intervalSec}s\n` +
      `cockpit ${baseUrl(cfg)}`,
    priority: 3,
    tags: ['rocket'],
    click: `${baseUrl(cfg)}/`,
    actions: [
      { label: 'Open Cockpit', url: `${baseUrl(cfg)}/`, clear: false },
    ],
  });

  // ── Scan loop ──
  let scanCount = 0;
  let scanInFlight = false;
  const scanTick = async () => {
    if (scanInFlight) {
      log.warn('previous scan still in flight — skipping this tick');
      return;
    }
    scanInFlight = true;
    scanCount += 1;
    try {
      await runScan({ cfg, provider, scanCount, eventBus });
    } catch (e) {
      log.err(`scan #${scanCount} crashed: ${e.message}`);
    } finally {
      scanInFlight = false;
    }
  };

  // ── Exit monitor loop ──
  let exitInFlight = false;
  const exitInterval = (cfg.exit?.intervalSec ?? DEFAULT_EXIT_INTERVAL_SEC) * 1000;
  const exitTick = async () => {
    if (exitInFlight) return;
    exitInFlight = true;
    try {
      await runExitMonitor({ cfg, provider, eventBus });
    } catch (e) {
      log.err(`exit-monitor crashed: ${e.message}`);
    } finally {
      exitInFlight = false;
    }
  };

  // Kick off both loops; first scan runs immediately, exit monitor lags by
  // 5s so the scan-result signals are persisted before the monitor checks.
  await scanTick();
  setInterval(scanTick, cfg.scan.intervalSec * 1000);
  setTimeout(() => {
    exitTick();
    setInterval(exitTick, exitInterval);
  }, 5_000);

  // ── Graceful shutdown ──
  const shutdown = (sig) => {
    log.boot(`received ${sig} — shutting down`);
    try {
      httpServer.close(() => process.exit(0));
    } catch {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
