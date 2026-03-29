/**
 * Cloudflare Worker — CORS proxy for Yahoo Finance v8 chart API + NSE API.
 * Includes:
 *   - Batch auth via X-Batch-Token header (SHA-256 validated against env.BATCH_AUTH_HASH)
 *   - IP-based rate limiting via KV (20 req/day for unauthenticated users)
 *
 * Deploy:
 *   cd worker && npx wrangler deploy
 *
 * Secrets (set via `wrangler secret put`):
 *   BATCH_AUTH_HASH — SHA-256 hex of the batch passphrase
 *
 * KV namespace binding (in wrangler.toml):
 *   RATE_LIMIT — for IP-based daily counters
 */

const ALLOWED_ORIGINS = [
  'https://utkarsh9891.github.io',
  'http://localhost',
  'http://127.0.0.1',
  'https://localhost',
  'capacitor://localhost',
];

const DAILY_LIMIT = 20;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some((o) => origin?.startsWith(o));
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Batch-Token',
    'Access-Control-Max-Age': '86400',
  };
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate batch token against stored hash.
 * Client sends SHA-256 hash of passphrase (never plaintext).
 * Worker compares directly to env.BATCH_AUTH_HASH.
 * Returns true if token is valid, false if invalid, null if no token provided.
 */
async function validateBatchToken(request, env) {
  const token = request.headers.get('X-Batch-Token');
  if (!token) return null; // no token = regular request
  if (!env.BATCH_AUTH_HASH) return false; // secret not configured
  return token === env.BATCH_AUTH_HASH;
}

/**
 * IP-based rate limiting via KV.
 * Returns { allowed: boolean, remaining: number }.
 */
async function checkRateLimit(request, env) {
  if (!env.RATE_LIMIT) return { allowed: true, remaining: DAILY_LIMIT }; // KV not bound, skip

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = await sha256(ip);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `rl:${ipHash.slice(0, 16)}:${today}`;

  const current = parseInt(await env.RATE_LIMIT.get(key) || '0', 10);
  if (current >= DAILY_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  // Increment — fire-and-forget to avoid blocking the response
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: 86400 });
  return { allowed: true, remaining: DAILY_LIMIT - current - 1 };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('url');

    if (!target) {
      return new Response('Bad request — missing url parameter', {
        status: 400,
        headers: corsHeaders(origin),
      });
    }

    const yahooOk = target.startsWith('https://query1.finance.yahoo.com/');
    const nseOk = target.startsWith('https://www.nseindia.com/api/');
    if (!yahooOk && !nseOk) {
      return new Response('Bad request — allowed: Yahoo chart API or NSE /api/* only', {
        status: 400,
        headers: corsHeaders(origin),
      });
    }

    // --- Auth & rate limiting ---
    const authResult = await validateBatchToken(request, env);

    if (authResult === false) {
      // Token was provided but is invalid
      return new Response(JSON.stringify({ error: 'Invalid batch token' }), {
        status: 403,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }

    // If no batch token, apply rate limiting
    if (authResult === null) {
      const { allowed, remaining } = await checkRateLimit(request, env);
      if (!allowed) {
        return new Response(
          JSON.stringify({ error: 'Daily limit exceeded. Try again tomorrow.' }),
          {
            status: 429,
            headers: {
              ...corsHeaders(origin),
              'Content-Type': 'application/json',
              'X-RateLimit-Remaining': '0',
            },
          }
        );
      }
    }
    // authResult === true means valid batch token — no rate limit

    // --- Proxy the request ---
    try {
      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'application/json',
      };
      if (nseOk) headers.Referer = 'https://www.nseindia.com/';

      const resp = await fetch(target, { headers });
      const body = await resp.text();

      return new Response(body, {
        status: resp.status,
        headers: {
          ...corsHeaders(origin),
          'Content-Type': resp.headers.get('Content-Type') || 'application/json',
          'Cache-Control': 'no-store',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }
  },
};
