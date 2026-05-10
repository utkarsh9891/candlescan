/**
 * Reusable interactive-prompt helpers for cockpit CLI commands.
 *
 * Built on Node's readline + a Writable wrapper that mutes stdout while
 * a passphrase is being typed. No external dep.
 */

import readline from 'node:readline';
import { Writable } from 'node:stream';

function makeMutedStdout() {
  const out = new Writable({
    write(chunk, encoding, cb) {
      if (!out.muted) process.stdout.write(chunk, encoding);
      cb();
    },
  });
  out.muted = false;
  return out;
}

function makeRl(useMute = false) {
  if (!useMute) {
    return readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  }
  const out = makeMutedStdout();
  const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
  rl._mutedOut = out;
  return rl;
}

/**
 * Plain text prompt. Optional default value.
 */
export async function ask(question, { defaultValue, required = false, validate } = {}) {
  const rl = makeRl(false);
  try {
    while (true) {
      const suffix = defaultValue != null && defaultValue !== '' ? ` [${defaultValue}]` : '';
      const ans = await new Promise((resolve) => rl.question(`${question}${suffix}: `, resolve));
      const v = ans.trim() || (defaultValue ?? '');
      if (required && !v) {
        process.stdout.write('  required.\n');
        continue;
      }
      if (validate) {
        const err = validate(v);
        if (err) {
          process.stdout.write(`  ${err}\n`);
          continue;
        }
      }
      return v;
    }
  } finally {
    rl.close();
  }
}

/**
 * Hidden-input prompt for passphrases / PINs / tokens.
 * Stdout is muted while the user types.
 */
export async function askSecret(question, { confirm = false, required = true, minLength = 0 } = {}) {
  const rl = makeRl(true);
  try {
    while (true) {
      process.stdout.write(`${question}: `);
      rl._mutedOut.muted = true;
      const v1 = await new Promise((resolve) => rl.question('', resolve));
      rl._mutedOut.muted = false;
      process.stdout.write('\n');
      if (required && !v1) {
        process.stdout.write('  required.\n');
        continue;
      }
      if (v1.length < minLength) {
        process.stdout.write(`  must be at least ${minLength} chars.\n`);
        continue;
      }
      if (confirm) {
        process.stdout.write(`${question} (confirm): `);
        rl._mutedOut.muted = true;
        const v2 = await new Promise((resolve) => rl.question('', resolve));
        rl._mutedOut.muted = false;
        process.stdout.write('\n');
        if (v1 !== v2) {
          process.stdout.write('  values did not match — try again.\n');
          continue;
        }
      }
      return v1;
    }
  } finally {
    rl.close();
  }
}

/**
 * Yes/no prompt. Returns boolean.
 */
export async function confirm(question, defaultYes = false) {
  const ans = await ask(`${question} (${defaultYes ? 'Y/n' : 'y/N'})`, { defaultValue: defaultYes ? 'y' : 'n' });
  return /^y(es)?$/i.test(ans.trim());
}

/**
 * One-of-N choice. Returns the selected value.
 */
export async function choose(question, choices, { defaultValue } = {}) {
  const labels = choices.map((c, i) => `${i + 1}) ${c.label || c.value}`).join('   ');
  const def = defaultValue != null
    ? String(choices.findIndex((c) => c.value === defaultValue) + 1)
    : '';
  while (true) {
    const raw = await ask(`${question}\n  ${labels}\n  Choice`, { defaultValue: def });
    const idx = parseInt(raw, 10);
    if (Number.isFinite(idx) && idx >= 1 && idx <= choices.length) {
      return choices[idx - 1].value;
    }
    process.stdout.write(`  pick 1..${choices.length}.\n`);
  }
}
