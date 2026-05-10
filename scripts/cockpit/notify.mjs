/**
 * Notification abstraction.
 *
 * Provider interface:
 *   send({ title, message, click, actions, priority, tags }) => Promise<{id}>
 *
 * Day 1 ships an ntfy provider. Telegram bot can be added as a second
 * provider with the same signature; swap is a one-line change at the
 * makeProvider() call site.
 */

import log from './log.mjs';

/**
 * @typedef {Object} NotifyAction
 * @property {string} label
 * @property {string} url
 * @property {boolean} [clear]
 */

/**
 * @typedef {Object} NotifyArgs
 * @property {string} title
 * @property {string} message
 * @property {string} [click] - URL opened on body tap
 * @property {NotifyAction[]} [actions]
 * @property {number} [priority] - 1..5, default 3
 * @property {string[]} [tags] - emoji shortcodes
 */

export function makeNtfyProvider({ server = 'https://ntfy.sh', topic }) {
  if (!topic) throw new Error('ntfy provider requires a topic');
  return {
    name: 'ntfy',
    /** @param {NotifyArgs} args */
    async send(args) {
      const body = {
        topic,
        title: args.title,
        message: args.message,
        priority: args.priority ?? 3,
        tags: args.tags ?? [],
      };
      if (args.click) body.click = args.click;
      if (args.actions?.length) {
        body.actions = args.actions.map((a) => ({
          action: 'view',
          label: a.label,
          url: a.url,
          clear: a.clear ?? false,
        }));
      }
      const res = await fetch(server, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`ntfy HTTP ${res.status} ${text}`.trim());
      }
      const json = await res.json();
      return { id: json.id };
    },
  };
}

/**
 * Send via the configured provider, with logging.
 * Errors are caught + logged — never thrown, since a notification failure
 * shouldn't kill the scan loop.
 *
 * @param {{name:string, send:(a:NotifyArgs)=>Promise<{id:string}>}} provider
 * @param {NotifyArgs} args
 */
export async function notify(provider, args) {
  try {
    const { id } = await provider.send(args);
    log.notify(`${provider.name}: "${args.title}" → id=${id}`);
    return { ok: true, id };
  } catch (e) {
    log.warn(`notify failed (${provider.name}): ${e.message}`);
    return { ok: false, error: e.message };
  }
}
