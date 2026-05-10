/**
 * Cockpit logger — categorized, colored, file-mirrored.
 *
 * Categories: BOOT, SCAN, SIGNAL, NOTIFY, TRADE, EXIT, AUTH, WARN, ERR, DEBUG.
 * Terminal: ANSI colors via tiny inline helpers (no dep).
 * File mirror: plain text at ~/.candlescan/cockpit/logs/<IST-date>.log
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LOG_DIR = path.join(os.homedir(), '.candlescan', 'cockpit', 'logs');
const TTY = process.stdout.isTTY && !process.env.NO_COLOR;

// Tiny inline ANSI helpers — chalk/picocolors equivalent for the few codes
// we use, with a global TTY check so logs are clean when piped to a file
// or captured by launchd.
const ESC = '\x1b[';
const reset = (s) => (TTY ? `${ESC}0m${s}${ESC}0m` : s);
const wrap = (open, close) => (s) => (TTY ? `${ESC}${open}m${s}${ESC}${close}m` : s);
const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

const CATS = {
  BOOT: { color: c.cyan, label: 'BOOT  ' },
  SCAN: { color: c.blue, label: 'SCAN  ' },
  SIGNAL: { color: c.magenta, label: 'SIGNAL' },
  NOTIFY: { color: (s) => c.dim(c.cyan(s)), label: 'NOTIFY' },
  TRADE: { color: c.green, label: 'TRADE ' },
  EXIT: { color: c.green, label: 'EXIT  ' },
  AUTH: { color: c.yellow, label: 'AUTH  ' },
  WARN: { color: c.yellow, label: 'WARN  ' },
  ERR: { color: (s) => c.bold(c.red(s)), label: 'ERR   ' },
  DEBUG: { color: c.gray, label: 'DEBUG ' },
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istNow() {
  return new Date(Date.now() + IST_OFFSET_MS);
}

function todayStamp() {
  return istNow().toISOString().slice(0, 10);
}

function timeStamp() {
  return istNow().toISOString().slice(11, 19);
}

function logFilePath() {
  return path.join(LOG_DIR, `${todayStamp()}.log`);
}

function fileWrite(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(logFilePath(), line + '\n');
  } catch (e) {
    process.stderr.write(`(log file write failed: ${e?.message}) ${line}\n`);
  }
}

function emit(category, glyph, message) {
  const cat = CATS[category] ?? CATS.DEBUG;
  const ts = timeStamp();
  const colored = `${c.dim('[' + ts + ']')}  ${c.bold(cat.color(cat.label))} ${glyph} ${message}`;
  process.stdout.write(colored + '\n');
  fileWrite(`[${ts}]  ${cat.label} ${glyph} ${message}`);
}

export const log = {
  boot: (msg) => emit('BOOT', '▸', msg),
  scan: (msg) => emit('SCAN', '▸', msg),
  scanOk: (msg) => emit('SCAN', '✓', msg),
  scanEnd: (msg) => emit('SCAN', '⏹', msg),
  signal: (msg) => emit('SIGNAL', '★', msg),
  notify: (msg) => emit('NOTIFY', '→', msg),
  tradeIn: (msg) => emit('TRADE', '+', msg),
  tradeOut: (msg) => emit('EXIT', '✓', msg),
  auth: (msg) => emit('AUTH', '⚠', msg),
  warn: (msg) => emit('WARN', '⚠', msg),
  err: (msg) => emit('ERR', '✗', msg),
  debug: (msg) => emit('DEBUG', '·', msg),
};

export default log;
