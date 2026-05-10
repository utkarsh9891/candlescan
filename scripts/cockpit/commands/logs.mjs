/**
 * `cockpit logs` — show today's log file.
 *
 * Defaults to the last 50 lines of today's IST-dated log. With `--follow`
 * (or `-f`), tails the file so new lines stream as they arrive.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LOG_DIR = path.join(os.homedir(), '.candlescan', 'cockpit', 'logs');
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export const help = `
cockpit logs [options]

  cockpit logs            print last 50 lines of today's log
  cockpit logs -f         follow today's log (stream new lines)
  cockpit logs --all      print the entire today's log
  cockpit logs <date>     print log for a specific YYYY-MM-DD

Logs live at ~/.candlescan/cockpit/logs/<IST-date>.log (plain text, no ANSI).
`.trim();

function todayIst() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function logPath(day) {
  return path.join(LOG_DIR, `${day}.log`);
}

export async function run(args) {
  let follow = false;
  let all = false;
  let day = todayIst();
  for (const a of args) {
    if (a === '-f' || a === '--follow') follow = true;
    else if (a === '--all') all = true;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) day = a;
  }

  const fp = logPath(day);
  if (!fs.existsSync(fp)) {
    console.log(`no log for ${day} at ${fp}`);
    return;
  }

  const content = fs.readFileSync(fp, 'utf8');
  const lines = content.split('\n');
  const printable = all ? lines : lines.slice(Math.max(0, lines.length - 51));
  process.stdout.write(printable.join('\n'));
  if (!printable.at(-1)?.endsWith('\n')) process.stdout.write('\n');

  if (!follow) return;

  // Follow: watch for size changes, print appended bytes.
  let lastSize = fs.statSync(fp).size;
  console.log(`\n— following ${fp} (Ctrl-C to stop) —`);
  fs.watchFile(fp, { interval: 500 }, (cur) => {
    if (cur.size > lastSize) {
      const stream = fs.createReadStream(fp, { start: lastSize, end: cur.size });
      stream.pipe(process.stdout);
      lastSize = cur.size;
    } else if (cur.size < lastSize) {
      // Truncated / rotated — restart from 0.
      lastSize = 0;
    }
  });
  await new Promise(() => {}); // forever, until SIGINT.
}
