import { describe, it, expect, vi } from 'vitest';
import { createSemaphore, retryWithBackoff, defaultShouldRetry } from './rateLimit.js';

describe('createSemaphore', () => {
  it('runs up to max concurrently and queues the rest', async () => {
    const sem = createSemaphore(2);
    let active = 0;
    let maxActive = 0;
    const makeTask = (delay) =>
      sem.run(async () => {
        active++;
        if (active > maxActive) maxActive = active;
        await new Promise((r) => setTimeout(r, delay));
        active--;
      });
    await Promise.all([makeTask(20), makeTask(20), makeTask(20), makeTask(20), makeTask(20)]);
    expect(maxActive).toBe(2);
  });

  it('serializes FIFO when max=1', async () => {
    const sem = createSemaphore(1);
    const order = [];
    const tasks = [];
    for (let i = 0; i < 4; i++) {
      tasks.push(
        sem.run(async () => {
          order.push(`start-${i}`);
          await new Promise((r) => setTimeout(r, 5));
          order.push(`end-${i}`);
        })
      );
    }
    await Promise.all(tasks);
    expect(order).toEqual([
      'start-0', 'end-0',
      'start-1', 'end-1',
      'start-2', 'end-2',
      'start-3', 'end-3',
    ]);
  });

  it('releases on throw so the queue drains', async () => {
    const sem = createSemaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    let ran = false;
    await sem.run(async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('supports manual acquire / release', async () => {
    const sem = createSemaphore(1);
    await sem.acquire();
    let secondAcquired = false;
    const p = sem.acquire().then(() => { secondAcquired = true; });
    // Next tick — shouldn't have acquired yet.
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    sem.release();
    await p;
    expect(secondAcquired).toBe(true);
    sem.release();
  });

  it('clamps max to >=1', async () => {
    const sem = createSemaphore(0);
    let ran = false;
    await sem.run(async () => { ran = true; });
    expect(ran).toBe(true);
  });
});

describe('retryWithBackoff', () => {
  it('returns value on first success', async () => {
    const fn = vi.fn(async () => 'ok');
    const out = await retryWithBackoff(fn);
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries 429 up to `retries` times then throws', async () => {
    const fn = vi.fn(async () => {
      const err = new Error('HTTP 429');
      err.status = 429;
      throw err;
    });
    const sleep = vi.fn(async () => {});
    await expect(
      retryWithBackoff(fn, { retries: 3, baseMs: 10, maxMs: 100, jitterMs: 0, sleepFn: sleep })
    ).rejects.toThrow('HTTP 429');
    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('honors exponential backoff timing (base * 2^attempt capped at maxMs)', async () => {
    let attempt = 0;
    const sleeps = [];
    const fn = vi.fn(async () => {
      const err = new Error('boom');
      err.status = 500;
      throw err;
    });
    const sleep = async (ms) => { sleeps.push(ms); };
    await expect(
      retryWithBackoff(fn, { retries: 3, baseMs: 100, maxMs: 1000, jitterMs: 0, sleepFn: sleep })
    ).rejects.toBeTruthy();
    // 100, 200, 400 (no jitter).
    expect(sleeps).toEqual([100, 200, 400]);
    attempt; // keep linter happy
  });

  it('caps backoff at maxMs', async () => {
    const sleeps = [];
    const fn = vi.fn(async () => {
      const err = new Error('boom');
      err.status = 503;
      throw err;
    });
    await expect(
      retryWithBackoff(fn, {
        retries: 5, baseMs: 1000, maxMs: 2000, jitterMs: 0,
        sleepFn: async (ms) => { sleeps.push(ms); },
      })
    ).rejects.toBeTruthy();
    // 1000, 2000 (cap), 2000, 2000, 2000
    expect(sleeps[0]).toBe(1000);
    expect(sleeps.slice(1)).toEqual([2000, 2000, 2000, 2000]);
  });

  it('does NOT retry non-retriable errors (e.g. 401)', async () => {
    const fn = vi.fn(async () => {
      const err = new Error('unauthorized');
      err.status = 401;
      throw err;
    });
    await expect(retryWithBackoff(fn, { retries: 3, baseMs: 1, sleepFn: async () => {} }))
      .rejects.toThrow('unauthorized');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('respects a custom shouldRetry predicate', async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n < 3) throw new Error('flake');
      return 'ok';
    });
    const out = await retryWithBackoff(fn, {
      retries: 5, baseMs: 1, jitterMs: 0, sleepFn: async () => {},
      shouldRetry: (e) => String(e.message).includes('flake'),
    });
    expect(out).toBe('ok');
    expect(n).toBe(3);
  });

  it('eventually succeeds if a retry works', async () => {
    let n = 0;
    const fn = async () => {
      n++;
      if (n < 2) {
        const e = new Error('rate limited');
        e.status = 429;
        throw e;
      }
      return 42;
    };
    const out = await retryWithBackoff(fn, { baseMs: 1, jitterMs: 0, sleepFn: async () => {} });
    expect(out).toBe(42);
    expect(n).toBe(2);
  });
});

describe('defaultShouldRetry', () => {
  it('retries 429 and 5xx, not 4xx', () => {
    expect(defaultShouldRetry({ status: 429 })).toBe(true);
    expect(defaultShouldRetry({ status: 500 })).toBe(true);
    expect(defaultShouldRetry({ status: 503 })).toBe(true);
    expect(defaultShouldRetry({ status: 401 })).toBe(false);
    expect(defaultShouldRetry({ status: 404 })).toBe(false);
    expect(defaultShouldRetry(null)).toBe(false);
  });

  it('matches status codes embedded in error messages', () => {
    expect(defaultShouldRetry({ message: 'HTTP 429: rate limited' })).toBe(true);
    expect(defaultShouldRetry({ message: 'HTTP 502 bad gateway' })).toBe(true);
    expect(defaultShouldRetry({ message: 'HTTP 404 not found' })).toBe(false);
  });
});
