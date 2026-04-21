/**
 * rateLimit.js — shared rate-limit primitives used by the chart fetchers.
 *
 * Two pieces:
 *
 *   createSemaphore(maxConcurrent)
 *     A tiny FIFO semaphore. Same shape as batchScan.js' news semaphore
 *     (acquire / release). Used to cap concurrent outbound requests to
 *     each upstream (Yahoo, Dhan, Kite) so we stay well inside vendor
 *     rate limits empirically observed during warm-cache runs.
 *
 *   retryWithBackoff(fn, opts)
 *     Runs `fn`, and on a retriable error sleeps `baseMs * 2^attempt`
 *     (capped at `maxMs`) + 0-250ms jitter, then tries again. Retries
 *     HTTP 429 and 5xx by default; 401/403 propagate immediately so the
 *     token-expiry pathway (TokenExpiredError in brokerErrors.js) is
 *     never retried.
 *
 * Neither piece depends on the browser — both are usable from Node (CLI
 * simulate) and the browser (live scans). The fetchers only enable the
 * browser localStorage cache when `typeof localStorage !== 'undefined'`,
 * but the semaphore + retry wrap upstream requests in both worlds.
 */

/**
 * FIFO semaphore. Resolve order matches acquire order.
 *
 * @param {number} maxConcurrent  Maximum concurrent holders (>= 1)
 * @returns {{ acquire: () => Promise<void>, release: () => void, run: (fn:Function)=>Promise<any> }}
 */
export function createSemaphore(maxConcurrent) {
  const max = Math.max(1, Math.floor(Number(maxConcurrent) || 1));
  let active = 0;
  const queue = [];

  const drain = () => {
    while (active < max && queue.length > 0) {
      active++;
      const next = queue.shift();
      next();
    }
  };

  const sem = {
    async acquire() {
      if (active < max) {
        active++;
        return;
      }
      await new Promise((resolve) => queue.push(resolve));
    },
    release() {
      active = Math.max(0, active - 1);
      drain();
    },
    /** Convenience: run `fn` while holding the semaphore. Guarantees release on throw. */
    async run(fn) {
      await sem.acquire();
      try {
        return await fn();
      } finally {
        sem.release();
      }
    },
  };
  return sem;
}

/** Default retry predicate: HTTP 429 (rate limit) or 5xx (transient server). */
export function defaultShouldRetry(err) {
  if (!err) return false;
  const status = Number(err.status || err.httpStatus || 0);
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  // Some fetchers stringify status into the message (e.g. "HTTP 429: ..." or plain "429").
  const msg = String(err.message || '');
  if (/\b429\b/.test(msg)) return true;
  if (/\bHTTP 5\d\d\b/.test(msg)) return true;
  return false;
}

/**
 * Exponential-backoff retry. Sleeps `min(baseMs * 2^attempt, maxMs)` + up to
 * 250ms of jitter between attempts. Only retries when `shouldRetry(err)` is
 * true — defaults to 429 / 5xx.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{
 *   retries?: number,
 *   baseMs?: number,
 *   maxMs?: number,
 *   shouldRetry?: (err: any) => boolean,
 *   jitterMs?: number,
 *   sleepFn?: (ms: number) => Promise<void>,
 * }} [opts]
 * @returns {Promise<T>}
 */
export async function retryWithBackoff(fn, opts = {}) {
  const retries = Math.max(0, Number(opts.retries ?? 3));
  const baseMs = Math.max(0, Number(opts.baseMs ?? 500));
  const maxMs = Math.max(baseMs, Number(opts.maxMs ?? 10_000));
  const jitterMs = Math.max(0, Number(opts.jitterMs ?? 250));
  const shouldRetry = typeof opts.shouldRetry === 'function' ? opts.shouldRetry : defaultShouldRetry;
  const sleep =
    typeof opts.sleepFn === 'function'
      ? opts.sleepFn
      : (ms) => new Promise((r) => setTimeout(r, ms));

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      if (!shouldRetry(err)) break;
      const delay = Math.min(maxMs, baseMs * Math.pow(2, attempt)) + Math.random() * jitterMs;
      await sleep(delay);
    }
  }
  throw lastErr;
}
