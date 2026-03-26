/**
 * Cloudflare Worker — CORS proxy for Yahoo Finance v8 chart API.
 * Deployed once; CandleScan front-end calls this instead of Yahoo directly.
 *
 * Deploy:
 *   cd worker && npx wrangler deploy
 */

const ALLOWED_ORIGINS = [
  'https://utkarsh9891.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some((o) => origin?.startsWith(o));
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request) {
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

    if (!target || !target.startsWith('https://query1.finance.yahoo.com/')) {
      return new Response('Bad request — only Yahoo Finance URLs allowed', {
        status: 400,
        headers: corsHeaders(origin),
      });
    }

    try {
      const resp = await fetch(target, {
        headers: { 'User-Agent': 'CandleScan/1.0' },
      });
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
