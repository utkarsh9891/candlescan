/**
 * Cloudflare Worker — CORS proxy for Yahoo Finance v8 chart API + NSE API + Zerodha Kite API.
 * Includes:
 *   - Gate auth via X-Gate-Token header (SHA-256 validated against env.GATE_PASSPHRASE_HASH)
 *   - IP-based rate limiting via KV (20 req/day for unauthenticated users)
 *   - RSA-encrypted credential vault for Zerodha API proxying
 *   - /gate/unlock endpoint to retrieve RSA public key
 *   - /zerodha/historical endpoint for proxied Kite API calls
 *
 * Deploy:
 *   cd worker && npx wrangler deploy
 *
 * Secrets (set via `wrangler secret put`):
 *   GATE_PASSPHRASE_HASH — SHA-256 hex of the premium passphrase
 *   GATE_PRIVATE_KEY — RSA private key PEM for vault decryption
 *
 * KV namespace bindings (in wrangler.toml):
 *   RATE_LIMIT — for IP-based daily counters
 *   CANDLESCAN_KV — for storing GATE_PUBLIC_KEY
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Gate-Token',
    'Access-Control-Max-Age': '86400',
  };
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate gate token against stored hash.
 * Client sends SHA-256 hash of passphrase (never plaintext).
 * Worker compares directly to env.GATE_PASSPHRASE_HASH.
 * Returns true if token is valid, false if invalid, null if no token provided.
 */
async function validateGateToken(request, env) {
  const token = request.headers.get('X-Gate-Token');
  if (!token) return null; // no token = regular request
  // Ignore tokens that don't look like SHA-256 hashes (stale plaintext tokens)
  if (!/^[a-f0-9]{64}$/.test(token)) return null; // treat as no token, not invalid
  if (!env.GATE_PASSPHRASE_HASH) return null; // secret not configured = skip auth
  return token === env.GATE_PASSPHRASE_HASH;
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

/**
 * Decrypt an RSA-OAEP + AES-GCM hybrid-encrypted vault blob.
 *
 * The client (credentialVault.js) stores the vault as base64 of a binary layout:
 *   [2 bytes: RSA ciphertext length (big-endian)]
 *   [RSA-encrypted AES key]
 *   [12 bytes: AES-GCM IV]
 *   [AES-GCM ciphertext (includes auth tag)]
 */
async function decryptVault(vaultBlob, privateKeyPem) {
  const raw = Uint8Array.from(atob(vaultBlob), c => c.charCodeAt(0));

  // Parse binary layout
  const rsaLen = (raw[0] << 8) | raw[1];
  const encKeyBuf = raw.slice(2, 2 + rsaLen);
  const ivBuf = raw.slice(2 + rsaLen, 2 + rsaLen + 12);
  const dataBuf = raw.slice(2 + rsaLen + 12);

  // Import RSA private key
  const pemBody = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, '')
    .replace(/-----END RSA PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const keyBuf = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const rsaKey = await crypto.subtle.importKey(
    'pkcs8', keyBuf, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']
  );

  // Decrypt AES key with RSA
  const aesKeyBuf = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, rsaKey, encKeyBuf);
  const aesKey = await crypto.subtle.importKey('raw', aesKeyBuf, 'AES-GCM', false, ['decrypt']);

  // Decrypt data with AES
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuf }, aesKey, dataBuf);

  return JSON.parse(new TextDecoder().decode(plainBuf));
}

/**
 * Handle /gate/unlock — validate passphrase hash and return public key.
 */
async function handleGateUnlock(request, env, origin) {
  const body = await request.json();
  const { gateHash } = body;

  if (!gateHash || !/^[a-f0-9]{64}$/.test(gateHash)) {
    return new Response(JSON.stringify({ error: 'Invalid gate hash format' }), {
      status: 400, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  if (!env.GATE_PASSPHRASE_HASH || gateHash !== env.GATE_PASSPHRASE_HASH) {
    return new Response(JSON.stringify({ error: 'Invalid passphrase' }), {
      status: 403, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  // Retrieve public key from KV
  let publicKey = null;
  if (env.CANDLESCAN_KV) {
    publicKey = await env.CANDLESCAN_KV.get('GATE_PUBLIC_KEY');
  }

  if (!publicKey) {
    return new Response(JSON.stringify({ error: 'Public key not configured' }), {
      status: 500, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ gatePublicKey: publicKey }), {
    status: 200, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

/**
 * Handle /zerodha/historical — decrypt vault and proxy to Kite API.
 */
async function handleZerodhaHistorical(request, env, origin) {
  // Validate gate token
  const authResult = await validateGateToken(request, env);
  if (authResult !== true) {
    return new Response(JSON.stringify({ error: 'Premium access required' }), {
      status: 403, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  const body = await request.json();
  const { symbol, interval, from, to, vault } = body;

  if (!symbol || !interval || !from || !to || !vault) {
    return new Response(JSON.stringify({ error: 'Missing required fields: symbol, interval, from, to, vault' }), {
      status: 400, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  if (!env.GATE_PRIVATE_KEY) {
    return new Response(JSON.stringify({ error: 'Zerodha proxy not configured (missing private key)' }), {
      status: 500, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  // Decrypt the vault to get Zerodha credentials
  let creds;
  try {
    creds = await decryptVault(vault, env.GATE_PRIVATE_KEY);
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Failed to decrypt credentials. Keys may have been rotated — re-enter credentials in Settings.' }), {
      status: 400, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  const { zerodhaApiKey, zerodhaAccessToken } = creds;
  if (!zerodhaApiKey || !zerodhaAccessToken) {
    return new Response(JSON.stringify({ error: 'Vault is missing Zerodha API key or access token' }), {
      status: 400, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  // Look up instrument token for the symbol
  // For now, we use the symbol directly and let the caller provide instrument_token if needed
  // Kite API v3: GET /instruments/historical/{instrument_token}/{interval}?from=...&to=...
  // Alternative: use the exchange:tradingsymbol format via /quote endpoint
  const kiteUrl = `https://api.kite.trade/instruments/NSE/${symbol}/historical/${interval}?from=${from}&to=${to}`;

  try {
    const resp = await fetch(kiteUrl, {
      headers: {
        'Authorization': `token ${zerodhaApiKey}:${zerodhaAccessToken}`,
        'X-Kite-Version': '3',
      },
    });

    const data = await resp.json();

    if (!resp.ok) {
      return new Response(JSON.stringify({ error: data.message || `Kite API error: ${resp.status}` }), {
        status: resp.status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Kite API fetch failed: ${err.message}` }), {
      status: 502, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Handle /zerodha/session — exchange request_token for access_token via Kite API.
 * Computes checksum server-side so api_secret never touches the browser.
 */
async function handleZerodhaSession(request, env, origin) {
  const authResult = await validateGateToken(request, env);
  if (authResult !== true) {
    return new Response(JSON.stringify({ error: 'Premium access required' }), {
      status: 403, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  const body = await request.json();
  const { apiKey, apiSecret, requestToken } = body;

  if (!apiKey || !apiSecret || !requestToken) {
    return new Response(JSON.stringify({ error: 'Missing required fields: apiKey, apiSecret, requestToken' }), {
      status: 400, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  // Compute checksum = SHA256(api_key + request_token + api_secret)
  const checksum = await sha256(apiKey + requestToken + apiSecret);

  try {
    const resp = await fetch('https://api.kite.trade/session/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Kite-Version': '3' },
      body: `api_key=${encodeURIComponent(apiKey)}&request_token=${encodeURIComponent(requestToken)}&checksum=${encodeURIComponent(checksum)}`,
    });

    const data = await resp.json();

    if (!resp.ok || data.status === 'error') {
      return new Response(JSON.stringify({ error: data.message || `Kite session failed (${resp.status})` }), {
        status: resp.status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }

    const accessToken = data.data?.access_token;
    if (!accessToken) {
      return new Response(JSON.stringify({ error: 'No access_token in Kite response' }), {
        status: 500, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ accessToken }), {
      status: 200, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Kite session exchange failed: ${err.message}` }), {
      status: 502, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Handle /zerodha/validate — decrypt vault and check token validity via Kite user/profile.
 */
async function handleZerodhaValidate(request, env, origin) {
  const authResult = await validateGateToken(request, env);
  if (authResult !== true) {
    return new Response(JSON.stringify({ error: 'Premium access required' }), {
      status: 403, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  const body = await request.json();
  const { vault } = body;

  if (!vault) {
    return new Response(JSON.stringify({ valid: false, error: 'No vault provided' }), {
      status: 400, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  if (!env.GATE_PRIVATE_KEY) {
    return new Response(JSON.stringify({ valid: false, error: 'Server not configured' }), {
      status: 500, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  let creds;
  try {
    creds = await decryptVault(vault, env.GATE_PRIVATE_KEY);
  } catch {
    return new Response(JSON.stringify({ valid: false, error: 'Failed to decrypt credentials' }), {
      status: 200, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  const { zerodhaApiKey, zerodhaAccessToken } = creds;
  if (!zerodhaApiKey || !zerodhaAccessToken) {
    return new Response(JSON.stringify({ valid: false, error: 'Missing credentials in vault' }), {
      status: 200, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  try {
    const resp = await fetch('https://api.kite.trade/user/profile', {
      headers: {
        'Authorization': `token ${zerodhaApiKey}:${zerodhaAccessToken}`,
        'X-Kite-Version': '3',
      },
    });

    if (resp.ok) {
      const data = await resp.json();
      return new Response(JSON.stringify({ valid: true, userName: data.data?.user_name || '' }), {
        status: 200, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }

    const errData = await resp.json().catch(() => ({}));
    return new Response(JSON.stringify({ valid: false, error: errData.message || `HTTP ${resp.status}` }), {
      status: 200, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ valid: false, error: err.message || 'Network error' }), {
      status: 200, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const path = url.pathname;

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // --- POST endpoints ---
    if (request.method === 'POST') {
      if (path === '/gate/unlock') {
        return handleGateUnlock(request, env, origin);
      }
      if (path === '/zerodha/historical') {
        return handleZerodhaHistorical(request, env, origin);
      }
      if (path === '/zerodha/session') {
        return handleZerodhaSession(request, env, origin);
      }
      if (path === '/zerodha/validate') {
        return handleZerodhaValidate(request, env, origin);
      }
      return new Response('Not found', { status: 404, headers: corsHeaders(origin) });
    }

    // --- GET proxy (Yahoo / NSE) ---
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders(origin) });
    }

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
    const authResult = await validateGateToken(request, env);

    if (authResult === false) {
      // Token was provided but is invalid
      return new Response(JSON.stringify({ error: 'Invalid gate token' }), {
        status: 403,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }

    // If no gate token, apply rate limiting
    if (authResult === null) {
      const { allowed, remaining } = await checkRateLimit(request, env);
      if (!allowed) {
        return new Response(
          JSON.stringify({ error: 'Daily limit exceeded. Unlock premium for unlimited access.' }),
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
    // authResult === true means valid gate token — no rate limit

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
