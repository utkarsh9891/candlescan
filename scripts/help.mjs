#!/usr/bin/env node
/**
 * `npm run help` — categorized listing of every npm script with a 1-line
 * description.
 *
 * `npm run` (no args) shows the raw command for each script, which is
 * noise. This prints "what does this do" instead, grouped by domain.
 *
 * Source of truth for descriptions is the GROUPS table below. When you
 * add a new script in package.json, register it here too — the script
 * verifies coverage at the bottom and warns about anything missing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

// ── ANSI helpers ─────────────────────────────────────────────────────
const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c(1), dim = c(2), cyan = c(36), gray = c(90);

// ── Description table ───────────────────────────────────────────────
// Order within each group is the order they're printed.
const GROUPS = [
  {
    title: 'Frontend / dev',
    scripts: [
      ['start',          'Vite dev server (alias: dev) — http://127.0.0.1:5173/candlescan/'],
      ['dev',            'Same as `start`'],
      ['build',          'Production build → dist/ (run before previewing or shipping)'],
      ['preview',        'Serve the built dist/ locally to verify the production build'],
    ],
  },
  {
    title: 'Tests',
    scripts: [
      ['test',           'Run all unit tests once (vitest)'],
      ['test:watch',     'Watch mode — re-runs affected tests on save'],
      ['test:coverage',  'Run all tests once with coverage report'],
    ],
  },
  {
    title: 'Simulation',
    scripts: [
      ['simulate',       'CLI bar-by-bar trading simulation; takes --date / --engine / etc'],
    ],
  },
  {
    title: 'Cockpit (Mac scan daemon)',
    scripts: [
      ['cockpit:start',       'Start the daemon (scan loop + paper-trade exit monitor + HTTP server)'],
      ['cockpit:stop',        'Gracefully stop the daemon (SIGTERM, escalates to SIGKILL after 5s)'],
      ['cockpit:status',      'Health summary: secrets / daemon running? / today\'s P&L'],
      ['cockpit:init',        'Interactive first-run wizard (ntfy topic, scan defaults)'],
      ['cockpit:config',      'Print effective config (redacted; pass `-- --show-secrets` to reveal)'],
      ['cockpit:logs',        'Print or follow today\'s cockpit log file'],
      ['cockpit:help',        'Cockpit CLI help; pass `-- <cmd>` for any subcommand'],
      ['cockpit:dhan',        'Manage Dhan broker creds (clientId + PIN; TOTP at boot)'],
      ['cockpit:zerodha',     'Manage Zerodha Kite creds (apiKey + apiSecret + daily access token)'],
      ['cockpit:gate',        'Optional passphrase that encrypts secrets.json fields at rest'],
      ['cockpit:rotate-topic','Generate a new ntfy push topic locally (no remote announcement)'],
    ],
  },
  {
    title: 'Local chart cache',
    scripts: [
      ['cache:warm',     'Quick warm of recent OHLCV (uses Yahoo\'s per-timeframe max retention)'],
      ['cache:backfill', 'Explicit date-range backfill (`-- --from 2026-04-01 --to 2026-04-30`)'],
      ['cache:sync',     'Warm + auto-commit + push to the candlescan-cache sibling repo'],
    ],
  },
  {
    title: 'Cloudflare Worker ops',
    scripts: [
      ['worker:rotate-keys', 'Rotate RSA keys + gate passphrase hash (interactive; one bundled flow)'],
      ['worker:audit-kv',    'Audit CANDLESCAN_* KV namespaces; pass `-- --clean` to delete stale'],
    ],
  },
  {
    title: 'Misc',
    scripts: [
      ['help',           'This screen'],
      ['prepare',        '(npm lifecycle) wires the local pre-push hook to .git-hooks/'],
    ],
  },
];

// ── Render ──────────────────────────────────────────────────────────
// Reserved npm shortcuts: `npm start`, `npm test`, `npm restart`, `npm stop`
// — these can be invoked without `run`. Everything else needs `npm run`.
const RESERVED_NPM = new Set(['start', 'test', 'restart', 'stop']);
const allScripts = new Set(Object.keys(PKG.scripts || {}));
const documented = new Set();

function renderRunForm(name) {
  return RESERVED_NPM.has(name) ? `npm ${name}` : `npm run ${name}`;
}

// Width-align based on the actual rendered prefix length.
let maxLeft = 0;
for (const g of GROUPS) for (const [name] of g.scripts) {
  if (!allScripts.has(name)) continue;
  const w = renderRunForm(name).length;
  if (w > maxLeft) maxLeft = w;
}
const COL_WIDTH = maxLeft + 2;  // 2-space gutter between command and description

const out = [];
out.push('');
out.push(bold(' CandleScan — npm scripts'));
out.push(dim(`   ${allScripts.size} scripts · ${GROUPS.length} groups`));

for (const g of GROUPS) {
  out.push('');
  out.push(bold(' ' + g.title));
  for (const [name, desc] of g.scripts) {
    if (!allScripts.has(name)) continue;
    documented.add(name);
    const left = renderRunForm(name);
    const pad = ' '.repeat(Math.max(2, COL_WIDTH - left.length));
    out.push(`   ${cyan(left)}${pad}${desc}`);
  }
}

const undocumented = [...allScripts].filter((s) => !documented.has(s));
if (undocumented.length) {
  out.push('');
  out.push(bold(' (undocumented — add an entry in scripts/help.mjs)'));
  for (const name of undocumented) {
    out.push(`   ${cyan(renderRunForm(name))}   ${gray('(no description)')}`);
  }
}

out.push('');
out.push(dim(` More detail per command: pass --help to any (e.g. \`npm run cockpit:help -- dhan\`).`));
out.push('');
process.stdout.write(out.join('\n'));
