/**
 * Cloudflare Worker — CORS proxy for Yahoo Finance v8 chart API + NSE API + Zerodha Kite API.
 * Includes:
 *   - Gate auth via X-Gate-Token header (SHA-256 validated against env.GATE_PASSPHRASE_HASH)
 *   - IP-based rate limiting via KV (20 req/day for unauthenticated users)
 *   - RSA-encrypted credential vault for Zerodha API proxying
 *   - /gate/unlock endpoint to retrieve RSA public key
 *   - /zerodha/historical endpoint for proxied Kite API calls
 *   - KV-backed stale-on-upstream-fail caches for /market/vix, /market/fiidii,
 *     /news/india, /news/google (see `worker/cache.js`)
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
 *   CANDLESCAN_KV — for storing GATE_PUBLIC_KEY + rate-hardened cache envelopes
 */

import {
  kvCacheFlow,
  cacheHeaders,
  vixKey,
  vixTtlMs,
  VIX_STALE_MAX_MS,
  fiidiiKey,
  FIIDII_TTL_MS,
  FIIDII_STALE_MAX_MS,
  indiaNewsKey,
  indiaNewsTtlMs,
  INDIA_NEWS_STALE_MAX_MS,
  googleNewsKey,
  GOOGLE_NEWS_TTL_MS,
  GOOGLE_NEWS_STALE_MAX_MS,
} from './cache.js';

const ALLOWED_ORIGINS = [
  'https://utkarsh9891.github.io',
  'http://localhost',
  'http://127.0.0.1',
  'https://localhost',
  'capacitor://localhost',
];

const DAILY_LIMIT = 20;
// Higher cap for the cached read-only endpoints (/news/*, /market/*) so a
// single legit user comfortably handles 5-10 scans/day × ~5 endpoint hits
// per scan, but a runaway script can't drain CF Workers' free 100k/day
// budget. Gate-token holders bypass entirely.
const PUBLIC_DAILY_LIMIT = 100;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some((o) => origin?.startsWith(o));
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Gate-Token',
    // Expose cache-observability headers so the browser / load-test can
    // read them (custom headers are otherwise hidden by CORS).
    'Access-Control-Expose-Headers': 'X-Cache, X-Cache-Age, X-Cache-Key, X-Cache-Source, X-RateLimit-Remaining',
    'Access-Control-Max-Age': '86400',
  };
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time string equality. Prevents timing-attack leakage of the
 * server-side GATE_PASSPHRASE_HASH secret byte-by-byte.
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
  return timingSafeEqual(token, env.GATE_PASSPHRASE_HASH);
}

/**
 * IP-based rate limiting via KV.
 * Returns { allowed: boolean, remaining: number }.
 *
 * `keyPrefix` namespaces independent counters so the proxy limit
 * (`rl:`) doesn't share a budget with the cached-endpoint limit
 * (`prl:`). `dailyLimit` controls how many requests an IP gets per
 * UTC day before hitting 429.
 */
async function checkRateLimit(request, env, { keyPrefix = 'rl', dailyLimit = DAILY_LIMIT } = {}) {
  if (!env.RATE_LIMIT) return { allowed: true, remaining: dailyLimit }; // KV not bound, skip

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = await sha256(ip);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `${keyPrefix}:${ipHash.slice(0, 16)}:${today}`;

  const current = parseInt(await env.RATE_LIMIT.get(key) || '0', 10);
  if (current >= dailyLimit) {
    return { allowed: false, remaining: 0 };
  }

  // Increment — fire-and-forget to avoid blocking the response
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: 86400 });
  return { allowed: true, remaining: dailyLimit - current - 1 };
}

/**
 * Gate-or-public-rate-limit guard for the cached read-only endpoints
 * (/news/india, /news/google, /market/vix, /market/fiidii). Returns:
 *   - null when the request is allowed to proceed
 *   - a Response (403/429) when it should be rejected
 *
 * Behaviour:
 *   - Valid gate token → bypass entirely (premium path).
 *   - Invalid gate token → 403.
 *   - No gate token + under PUBLIC_DAILY_LIMIT → allow, increment counter.
 *   - No gate token + over limit → 429.
 *
 * This is what stops a bored attacker draining CF Workers' free
 * 100k/day request budget by curl-spamming `/news/india` from a single IP.
 */
async function publicEndpointGuard(request, env, origin) {
  const auth = await validateGateToken(request, env);
  if (auth === false) {
    return new Response(JSON.stringify({ error: 'Invalid gate token' }), {
      status: 403,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }
  if (auth === true) return null; // premium bypass

  const { allowed, remaining } = await checkRateLimit(request, env, {
    keyPrefix: 'prl',
    dailyLimit: PUBLIC_DAILY_LIMIT,
  });
  if (!allowed) {
    return new Response(
      JSON.stringify({ error: 'Daily limit exceeded for public endpoint. Unlock premium for unlimited access.' }),
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
  return null;
}

// Routes guarded by publicEndpointGuard. Each is cheap (KV-cached, single
// upstream fetch on miss), but unauthenticated callers can still drain the
// CF Workers free-tier budget by spamming them, so we cap at PUBLIC_DAILY_LIMIT.
// Gate-token holders bypass.
const PUBLIC_RATE_LIMITED_PATHS = new Set([
  '/news/india',
  '/news/google',
  '/market/vix',
  '/market/fiidii',
]);

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
 * Resolve NSE tradingsymbol to Kite instrument_token.
 * Downloads the full NSE instruments CSV from Kite, parses it, and caches
 * the symbol→token map in KV for 24 hours.
 */
async function resolveInstrumentToken(symbol, authHeader, env) {
  const KV_KEY = 'kite_nse_instruments';
  const sym = symbol.toUpperCase();

  // Try KV cache first
  if (env.CANDLESCAN_KV) {
    const cached = await env.CANDLESCAN_KV.get(KV_KEY, 'json');
    if (cached && cached[sym]) return cached[sym];
    // If cached but symbol not found, still try a fresh fetch below
    // (in case instrument was recently listed)
  }

  // Fetch NSE instruments CSV from Kite
  const resp = await fetch('https://api.kite.trade/instruments/NSE', {
    headers: { 'Authorization': authHeader, 'X-Kite-Version': '3' },
  });
  if (!resp.ok) throw new Error(`Instruments API ${resp.status}`);

  const csv = await resp.text();
  // CSV format: instrument_token,exchange_token,tradingsymbol,name,...
  // First line is header
  const lines = csv.split('\n');
  const map = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 3) continue;
    const token = cols[0]; // instrument_token
    const tradingsymbol = (cols[2] || '').replace(/"/g, '');
    if (tradingsymbol) map[tradingsymbol] = token;
  }

  // Cache in KV for 24h
  if (env.CANDLESCAN_KV) {
    try {
      await env.CANDLESCAN_KV.put(KV_KEY, JSON.stringify(map), { expirationTtl: 86400 });
    } catch { /* KV write failed — non-fatal */ }
  }

  if (!map[sym]) throw new Error(`Symbol "${sym}" not found in NSE instruments`);
  return map[sym];
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

  const authHeader = `token ${zerodhaApiKey}:${zerodhaAccessToken}`;

  // Resolve instrument_token for the NSE symbol (cached in KV for 24h)
  let instrumentToken;
  try {
    instrumentToken = await resolveInstrumentToken(symbol, authHeader, env);
  } catch (err) {
    return new Response(JSON.stringify({ error: `Instrument lookup failed: ${err.message}` }), {
      status: 400, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  const kiteUrl = `https://api.kite.trade/instruments/historical/${instrumentToken}/${interval}?from=${from}&to=${to}`;

  try {
    const resp = await fetch(kiteUrl, {
      headers: { 'Authorization': authHeader, 'X-Kite-Version': '3' },
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      let errMsg;
      try { errMsg = JSON.parse(errText).message; } catch { errMsg = errText.slice(0, 200); }
      return new Response(JSON.stringify({ error: errMsg || `Kite API error: ${resp.status}` }), {
        status: resp.status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }

    const data = await resp.json();
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

// ─── Dhan ────────────────────────────────────────────────────────────

/**
 * Resolve NSE tradingsymbol to Dhan securityId.
 * Downloads the scrip master CSV, parses it, caches in KV for 24h.
 */
/**
 * Load the full Dhan NSE instrument map (symbol → securityId).
 * Uses a 7-day KV cache to avoid re-fetching the 32MB CSV on every request.
 * Returns the full map — used by the /dhan/instruments endpoint so the
 * client can cache it locally and do all symbol resolution client-side.
 */
async function loadDhanInstrumentMap(env, { forceRefresh = false } = {}) {
  const KV_KEY = 'dhan_nse_instruments';

  if (!forceRefresh && env.CANDLESCAN_KV) {
    const cached = await env.CANDLESCAN_KV.get(KV_KEY, 'json');
    if (cached && Object.keys(cached).length > 0) return cached;
  }

  const resp = await fetch('https://images.dhan.co/api-data/api-scrip-master.csv');
  if (!resp.ok) throw new Error(`Dhan scrip master fetch failed: ${resp.status}`);

  const csv = await resp.text();
  const lines = csv.split('\n');
  // Header: SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,...,SEM_TRADING_SYMBOL,...
  const header = lines[0].split(',');
  const exchIdx = header.indexOf('SEM_EXM_EXCH_ID');
  const secIdIdx = header.indexOf('SEM_SMST_SECURITY_ID');
  const symIdx = header.indexOf('SEM_TRADING_SYMBOL');
  const instrIdx = header.indexOf('SEM_INSTRUMENT_NAME');

  const map = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length <= symIdx) continue;
    const exch = (cols[exchIdx] || '').trim();
    const instr = (cols[instrIdx] || '').trim();
    // Only NSE equities and indices
    if (exch !== 'NSE' || (instr !== 'EQUITY' && instr !== 'INDEX')) continue;
    const tradingSym = (cols[symIdx] || '').replace(/"/g, '').trim();
    const secId = (cols[secIdIdx] || '').trim();
    if (tradingSym && secId) map[tradingSym] = secId;
  }

  // Cache for 7 days — Dhan adds listings infrequently (weekly at most).
  if (env.CANDLESCAN_KV) {
    try { await env.CANDLESCAN_KV.put(KV_KEY, JSON.stringify(map), { expirationTtl: 7 * 86400 }); } catch { /* ok */ }
  }

  return map;
}

/**
 * Handle /dhan/instruments — serves the full NSE equity symbol → securityId map.
 * Called once by the client on Dhan token connect; result cached in localStorage.
 * Supports ?refresh=1 query param to force a fresh CSV pull (bypasses KV).
 * Gate token required.
 */
async function handleDhanInstruments(request, env, origin) {
  try {
    const authResult = await validateGateToken(request, env);
    if (authResult !== true) {
      return new Response(JSON.stringify({ error: 'Premium access required' }), {
        status: 403, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(request.url);
    const forceRefresh = url.searchParams.get('refresh') === '1';
    const map = await loadDhanInstrumentMap(env, { forceRefresh });

    return new Response(JSON.stringify({
      instruments: map,
      count: Object.keys(map).length,
      generatedAt: new Date().toISOString(),
    }), {
      status: 200,
      headers: {
        ...corsHeaders(origin),
        'Content-Type': 'application/json',
        // Client should cache locally forever — re-fetch only on manual refresh
        'Cache-Control': 'private, max-age=604800', // 7 days
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Failed to load instruments: ${err.message || err}` }), {
      status: 500, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Broad Indian news RSS map — Moneycontrol + LiveMint + Economic Times
 * merged into a single payload. Each item carries the publisher tag so
 * the client can attribute headlines in the UI.
 *
 * Per-feed `ua` overrides the default User-Agent — Moneycontrol returns
 * empty bodies to the default `candlescan-proxy` UA when called from
 * Cloudflare egress IPs, so we send Googlebot which they whitelist for
 * indexing. (Business Standard was previously in the list but blocked
 * with HTTP 403 even on Googlebot — dropped to keep the feed list clean.)
 *
 * Throws if every feed fetch fails (so `kvCacheFlow` can route to the
 * stale fallback). Per-feed failure is non-fatal — we still return what
 * the surviving feeds produced.
 *
 * Returns `{ items, count, fetchedAt }` on success.
 */
const DEFAULT_NEWS_UA = 'Mozilla/5.0 (candlescan-proxy)';
const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const INDIA_NEWS_FEEDS = [
  // Moneycontrol — daily-discussed buzz + macro/markets context
  // (Googlebot UA — default UA gets empty bodies from CF egress)
  { url: 'https://www.moneycontrol.com/rss/buzzingstocks.xml', publisher: 'Moneycontrol', ua: GOOGLEBOT_UA },
  { url: 'https://www.moneycontrol.com/rss/MCtopnews.xml', publisher: 'Moneycontrol', ua: GOOGLEBOT_UA },
  { url: 'https://www.moneycontrol.com/rss/marketreports.xml', publisher: 'Moneycontrol', ua: GOOGLEBOT_UA },
  { url: 'https://www.moneycontrol.com/rss/business.xml', publisher: 'Moneycontrol', ua: GOOGLEBOT_UA },
  // LiveMint — markets section
  { url: 'https://www.livemint.com/rss/markets', publisher: 'LiveMint' },
  // Economic Times — stocks-in-news + broader markets
  { url: 'https://economictimes.indiatimes.com/markets/stocks/news/rssfeeds/2146842.cms', publisher: 'Economic Times' },
  { url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', publisher: 'Economic Times' },
];

async function fetchIndiaNewsUpstream() {
  const items = [];
  let anySuccess = false;
  let lastErr = null;
  for (const { url, publisher, ua } of INDIA_NEWS_FEEDS) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': ua || DEFAULT_NEWS_UA },
      });
      if (!resp.ok) {
        lastErr = new Error(`${publisher} ${url} HTTP ${resp.status}`);
        continue;
      }
      anySuccess = true;
      const xml = await resp.text();
      // Parse minimal RSS items inline — same logic as newsSentiment.parseRssItems
      const rawItems = xml.split(/<item[\s>]/i).slice(1);
      for (const raw of rawItems) {
        let title = '';
        const t = raw.match(/<title>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/title>/i);
        if (t) title = (t[1] || t[2] || '').trim();
        let description = '';
        const d = raw.match(/<description>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/description>/i);
        if (d) description = (d[1] || d[2] || '').trim().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        let link = '';
        const lk = raw.match(/<link>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/link>/i);
        if (lk) link = (lk[1] || lk[2] || '').trim();
        if (title) items.push({ title, description, link, publisher });
      }
    } catch (err) {
      lastErr = err;
    }
  }
  if (!anySuccess) throw lastErr || new Error('All India news feeds failed');
  return { items, count: items.length, fetchedAt: new Date().toISOString() };
}

/**
 * Handle /news/india — proxy the broad Indian news RSS feeds. Browser
 * can't hit these origins directly (CORS blocked). We merge all feeds
 * into a single JSON array of items so the browser only makes one
 * request. Client-side scoring via newsSentiment.js.
 *
 * Cache tiering:
 *   - Market hours: 10 min KV
 *   - Off-hours: 60 min KV
 *   - Upstream 502/timeout: stale up to 4h returned with X-Cache=STALE.
 */
async function handleIndiaNews(request, env, origin) {
  const nowMs = Date.now();
  const key = indiaNewsKey(nowMs);
  const ttlMs = indiaNewsTtlMs(nowMs);

  try {
    const result = await kvCacheFlow({
      kv: env.CANDLESCAN_KV,
      key,
      ttlMs,
      staleMaxMs: INDIA_NEWS_STALE_MAX_MS,
      fetchFresh: fetchIndiaNewsUpstream,
      unavailablePayload: () => ({ items: [], count: 0, fetchedAt: new Date().toISOString(), source: 'unavailable' }),
    });
    if (result.warnMessage) console.warn(result.warnMessage);
    return new Response(JSON.stringify(result.payload), {
      status: 200,
      headers: {
        ...corsHeaders(origin),
        ...cacheHeaders({ status: result.status, key: result.key, ageMs: result.ageMs ?? 0 }),
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300', // 5 min edge cache on top of KV
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `India news fetch failed: ${err?.message || err}` }), {
      status: 502, headers: { ...corsHeaders(origin), ...cacheHeaders({ status: 'MISS', key }), 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Fetch + parse the Google News RSS feed for a given symbol.
 * Throws on upstream 5xx/429/network — `kvCacheFlow` catches and
 * falls back to stale cache or the "unavailable" sentinel.
 */
async function fetchGoogleNewsUpstream(symbol) {
  const q = encodeURIComponent(`${symbol} stock NSE`);
  const feedUrl = `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
  const resp = await fetch(feedUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (candlescan-proxy)' },
  });
  // Treat 5xx + 429 as "upstream failed" so the stale branch kicks in.
  // 4xx other than 429 is a hard fail — propagate so the caller sees it.
  if (!resp.ok) {
    const err = new Error(`Google RSS HTTP ${resp.status}`);
    err.upstreamStatus = resp.status;
    throw err;
  }
  const xml = await resp.text();
  const items = [];
  const rawItems = xml.split(/<item[\s>]/i).slice(1);
  for (const raw of rawItems) {
    let title = '';
    const t = raw.match(/<title>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/title>/i);
    if (t) title = (t[1] || t[2] || '').trim();
    let description = '';
    const d = raw.match(/<description>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/description>/i);
    if (d) description = (d[1] || d[2] || '').trim().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    let pubDate = '';
    const pd = raw.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    if (pd) pubDate = pd[1].trim();
    let link = '';
    const lk = raw.match(/<link>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/link>/i);
    if (lk) link = (lk[1] || lk[2] || '').trim();
    if (title) items.push({ title, description, pubDate, link });
  }
  return { symbol, items, count: items.length, fetchedAt: new Date().toISOString() };
}

/**
 * Handle /news/google — per-symbol Google News RSS proxy.
 * Browser calls this for top-N ranked candidates after phase 3 to
 * get per-stock news context. One HTTP call per symbol — the browser
 * is expected to batch this (parallel Promise.all) rather than loop.
 *
 * Response: { items: [{title, description}, ...], symbol, count }
 * Client parses + scores via newsSentiment.scoreText.
 *
 * Cache behaviour:
 *   - Key `google_news:${symbol}:${YYYY-MM-DD}` in KV.
 *   - Fresh window 4h, stale window 24h.
 *   - On upstream 502/timeout/429 with no cache: returns HTTP 200 with
 *     `{headlines:[], score:null, source:'unavailable'}` so the caller
 *     doesn't retry pointlessly. X-Cache header = UNAVAILABLE in that case.
 */
async function handleGoogleNewsForSymbol(request, env, origin) {
  const url = new URL(request.url);
  const rawSym = url.searchParams.get('symbol') || '';
  const symbol = rawSym.replace(/[^A-Za-z0-9&-]/g, '').slice(0, 24);
  if (!symbol) {
    return new Response(JSON.stringify({ error: 'Missing or invalid symbol parameter' }), {
      status: 400, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  const nowMs = Date.now();
  const key = googleNewsKey(symbol, nowMs);

  try {
    const result = await kvCacheFlow({
      kv: env.CANDLESCAN_KV,
      key,
      ttlMs: GOOGLE_NEWS_TTL_MS,
      staleMaxMs: GOOGLE_NEWS_STALE_MAX_MS,
      fetchFresh: () => fetchGoogleNewsUpstream(symbol),
      unavailablePayload: () => ({
        symbol,
        items: [],
        headlines: [],
        score: null,
        count: 0,
        fetchedAt: new Date().toISOString(),
        source: 'unavailable',
      }),
    });
    if (result.warnMessage) console.warn(result.warnMessage);
    const sourceTag = result.status === 'HIT' ? 'fresh'
      : result.status === 'MISS' ? 'miss'
      : result.status === 'STALE' ? 'stale'
      : 'unavailable';
    return new Response(JSON.stringify(result.payload), {
      status: 200,
      headers: {
        ...corsHeaders(origin),
        ...cacheHeaders({ status: result.status, key: result.key, ageMs: result.ageMs ?? 0, cacheSource: sourceTag }),
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=600', // 10 min edge cache on top of KV
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Google News fetch failed: ${err?.message || err}` }), {
      status: 502, headers: { ...corsHeaders(origin), ...cacheHeaders({ status: 'MISS', key }), 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Fetch India VIX close from Yahoo — throws on upstream failure.
 */
async function fetchVixUpstream() {
  const resp = await fetch(
    'https://query1.finance.yahoo.com/v8/finance/chart/%5EINDIAVIX?interval=1d&range=5d',
    { headers: { 'User-Agent': 'Mozilla/5.0 (candlescan-proxy)' } }
  );
  if (!resp.ok) throw new Error(`Yahoo HTTP ${resp.status}`);
  const data = await resp.json();
  const result = data?.chart?.result?.[0];
  if (!result?.indicators?.quote?.[0]?.close) throw new Error('No VIX data in response');
  const closes = result.indicators.quote[0].close;
  let vixClose = null;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] != null && Number.isFinite(closes[i])) { vixClose = closes[i]; break; }
  }
  if (vixClose == null) throw new Error('No finite VIX close found');
  return { vix: vixClose, fetchedAt: new Date().toISOString() };
}

/**
 * Handle /market/vix — return current India VIX close + regime.
 * Called once at scan start so the browser has the latest VIX value
 * for regime-gating / sizing in the trade decision flow.
 *
 * Cache:
 *   - Key `nse_vix_daily:${YYYY-MM-DD-IST}`
 *   - TTL 1h during market hours, 24h otherwise.
 *   - Stale fallback up to 24h on upstream failure.
 */
async function handleVixFetch(request, env, origin) {
  const nowMs = Date.now();
  const key = vixKey(nowMs);
  try {
    const result = await kvCacheFlow({
      kv: env.CANDLESCAN_KV,
      key,
      ttlMs: vixTtlMs(nowMs),
      staleMaxMs: VIX_STALE_MAX_MS,
      fetchFresh: fetchVixUpstream,
      // No unavailable payload — caller wants a hard 502 if we can't supply VIX.
    });
    if (result.warnMessage) console.warn(result.warnMessage);
    return new Response(JSON.stringify(result.payload), {
      status: 200,
      headers: {
        ...corsHeaders(origin),
        ...cacheHeaders({ status: result.status, key: result.key, ageMs: result.ageMs ?? 0 }),
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `VIX fetch failed: ${err?.message || err}` }), {
      status: 502, headers: { ...corsHeaders(origin), ...cacheHeaders({ status: 'UNAVAILABLE', key }), 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Fetch FII/DII flow from NSE — throws on upstream failure.
 */
async function fetchFiiDiiUpstream() {
  // Step 1: get session cookies from NSE home page
  const homeResp = await fetch('https://www.nseindia.com/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html',
    },
  });
  const setCookies = homeResp.headers.get('set-cookie') || '';
  const cookieHeader = setCookies
    .split(/,(?=\s*\w+=)/)
    .map((c) => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');

  // Step 2: call the API with cookies + referer
  const apiResp = await fetch('https://www.nseindia.com/api/fiidiiTradeReact', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.nseindia.com/reports/fii-dii',
      'Cookie': cookieHeader,
    },
  });
  if (!apiResp.ok) throw new Error(`NSE HTTP ${apiResp.status}`);
  const rows = await apiResp.json();
  if (!Array.isArray(rows)) throw new Error('Unexpected response shape');

  let fii = null, dii = null, date = null;
  for (const r of rows) {
    const cat = String(r.category || '').toUpperCase();
    const net = parseFloat(r.netValue);
    if (!Number.isFinite(net)) continue;
    if (cat.includes('FII') || cat.includes('FPI')) fii = net;
    if (cat.includes('DII')) dii = net;
    if (r.date) date = r.date;
  }
  if (fii == null && dii == null) throw new Error('No FII/DII rows found');

  return { fii, dii, date, fetchedAt: new Date().toISOString() };
}

/**
 * Handle /market/fiidii — return latest FII/DII net values.
 * NSE's /api/fiidiiTradeReact requires a session cookie fetched from
 * the home page first, and a Referer header. This handler manages
 * both. Returns { fii: number, dii: number, date: string }.
 *
 * Cache:
 *   - Key `nse_fiidii_daily:${YYYY-MM-DD-IST}`
 *   - TTL 6h (values update once EOD).
 *   - Stale fallback up to 48h on upstream failure.
 */
async function handleFiiDiiFetch(request, env, origin) {
  const nowMs = Date.now();
  const key = fiidiiKey(nowMs);
  try {
    const result = await kvCacheFlow({
      kv: env.CANDLESCAN_KV,
      key,
      ttlMs: FIIDII_TTL_MS,
      staleMaxMs: FIIDII_STALE_MAX_MS,
      fetchFresh: fetchFiiDiiUpstream,
    });
    if (result.warnMessage) console.warn(result.warnMessage);
    return new Response(JSON.stringify(result.payload), {
      status: 200,
      headers: {
        ...corsHeaders(origin),
        ...cacheHeaders({ status: result.status, key: result.key, ageMs: result.ageMs ?? 0 }),
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=600', // 10 min edge cache on top of KV
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `FII/DII fetch failed: ${err?.message || err}` }), {
      status: 502, headers: { ...corsHeaders(origin), ...cacheHeaders({ status: 'UNAVAILABLE', key }), 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Handle /dhan/historical — decrypt vault and proxy to Dhan API.
 */
async function handleDhanHistorical(request, env, origin) {
  try {
  const authResult = await validateGateToken(request, env);
  if (authResult !== true) {
    return new Response(JSON.stringify({ error: 'Premium access required' }), {
      status: 403, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  const body = await request.json();
  const { symbol, securityId: clientSecurityId, interval, from, to, vault, dhanClientId } = body;

  if (!symbol || !interval || !from || !to || !vault) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), {
      status: 400, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }
  if (!clientSecurityId) {
    return new Response(JSON.stringify({
      error: 'Missing securityId — client out of date. Refresh instrument list in Settings.',
      code: 'STALE_CLIENT',
    }), {
      status: 400, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  if (!env.GATE_PRIVATE_KEY) {
    return new Response(JSON.stringify({ error: 'Server not configured' }), {
      status: 500, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  let creds;
  try {
    creds = await decryptVault(vault, env.GATE_PRIVATE_KEY);
  } catch {
    return new Response(JSON.stringify({ error: 'Failed to decrypt credentials' }), {
      status: 400, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  const { dhanAccessToken } = creds;
  if (!dhanAccessToken) {
    return new Response(JSON.stringify({ error: 'Vault is missing Dhan access token' }), {
      status: 400, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  // Client ID from request body (stored in localStorage on client)
  const clientId = dhanClientId || '';

  // Client supplies the resolved securityId from its own instrument cache.
  // Worker no longer maintains a per-request KV lookup on the hot path —
  // that role has moved to /dhan/instruments + client-side cache.
  const securityId = String(clientSecurityId);

  const isIntraday = interval !== 'day';
  const dhanUrl = isIntraday
    ? 'https://api.dhan.co/v2/charts/intraday'
    : 'https://api.dhan.co/v2/charts/historical';

  const reqBody = {
    securityId,
    exchangeSegment: 'NSE_EQ',
    instrument: 'EQUITY',
    expiryCode: 0,
    oi: false,
    fromDate: from,
    toDate: to,
  };
  if (isIntraday) reqBody.interval = interval;

  try {
    const resp = await fetch(dhanUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'access-token': dhanAccessToken,
        ...(clientId ? { 'client-id': clientId } : {}),
      },
      body: JSON.stringify(reqBody),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      let errMsg;
      try {
        const parsed = JSON.parse(errText);
        errMsg = parsed.remarks || parsed.message || parsed.errorMessage || parsed.error || errText;
      } catch { errMsg = errText || `(empty body)`; }
      return new Response(JSON.stringify({ error: `Dhan API ${resp.status}: ${errMsg}` }), {
        status: resp.status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }

    const data = await resp.json();
    // Dhan returns: { open: [...], high: [...], low: [...], close: [...], volume: [...], timestamp: [...] }
    const timestamps = data.timestamp || [];
    const opens = data.open || [];
    const highs = data.high || [];
    const lows = data.low || [];
    const closes = data.close || [];
    const volumes = data.volume || [];

    const candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      // Dhan returns epoch seconds as numbers — use directly.
      // If it's a string (e.g. ISO 8601), parse it.
      const raw = timestamps[i];
      const tSec = typeof raw === 'number' ? raw : Math.floor(new Date(raw).getTime() / 1000);
      candles.push({
        t: tSec,
        o: opens[i],
        h: highs[i],
        l: lows[i],
        c: closes[i],
        v: volumes[i] || 0,
      });
    }

    return new Response(JSON.stringify({ candles }), {
      status: 200,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Dhan API fetch failed: ${err.message}` }), {
      status: 502, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }
  } catch (outerErr) {
    // Catch-all to prevent Cloudflare 1101 Worker crashes
    return new Response(JSON.stringify({ error: `Worker crash in /dhan/historical: ${outerErr.message || outerErr}` }), {
      status: 500, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Handle /dhan/validate — decrypt vault and check token validity.
 */
async function handleDhanValidate(request, env, origin) {
  const authResult = await validateGateToken(request, env);
  if (authResult !== true) {
    return new Response(JSON.stringify({ error: 'Premium access required' }), {
      status: 403, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  const body = await request.json();
  const { vault, dhanClientId } = body;

  if (!vault || !env.GATE_PRIVATE_KEY) {
    return new Response(JSON.stringify({ valid: false, error: 'Missing vault or server config' }), {
      status: 200, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  let creds;
  try {
    creds = await decryptVault(vault, env.GATE_PRIVATE_KEY);
  } catch {
    return new Response(JSON.stringify({ valid: false, error: 'Failed to decrypt' }), {
      status: 200, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  const { dhanAccessToken } = creds;
  if (!dhanAccessToken) {
    return new Response(JSON.stringify({ valid: false, error: 'No Dhan token in vault' }), {
      status: 200, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  // Try a lightweight Dhan API call to check token
  try {
    const resp = await fetch('https://api.dhan.co/v2/fundlimit', {
      headers: {
        'access-token': dhanAccessToken,
        'Content-Type': 'application/json',
        ...(dhanClientId ? { 'client-id': dhanClientId } : {}),
      },
    });
    if (resp.ok) {
      return new Response(JSON.stringify({ valid: true }), {
        status: 200, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }
    const errData = await resp.json().catch(() => ({}));
    return new Response(JSON.stringify({ valid: false, error: errData.remarks || `HTTP ${resp.status}` }), {
      status: 200, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ valid: false, error: err.message }), {
      status: 200, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Handle /dhan/session — generate access token using Client ID + PIN + TOTP.
 * No vault needed — uses plaintext credentials from the request body.
 * The resulting access token is returned to the client for vault encryption.
 */
async function handleDhanSession(request, env, origin) {
  const authResult = await validateGateToken(request, env);
  if (authResult !== true) {
    return new Response(JSON.stringify({ error: 'Premium access required' }), {
      status: 403, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  const body = await request.json();
  const { dhanClientId, pin, totp } = body;

  if (!dhanClientId || !pin || !totp) {
    return new Response(JSON.stringify({ error: 'Missing required fields: dhanClientId, pin, totp' }), {
      status: 400, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

  try {
    const url = `https://auth.dhan.co/app/generateAccessToken?dhanClientId=${encodeURIComponent(dhanClientId)}&pin=${encodeURIComponent(pin)}&totp=${encodeURIComponent(totp)}`;
    const resp = await fetch(url, { method: 'POST' });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      let errMsg;
      try { errMsg = JSON.parse(errText).remarks || JSON.parse(errText).message; } catch { errMsg = errText.slice(0, 200); }
      return new Response(JSON.stringify({ error: errMsg || `Dhan auth error: ${resp.status}` }), {
        status: resp.status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }

    const rawText = await resp.text();
    let data;
    try { data = JSON.parse(rawText); } catch {
      return new Response(JSON.stringify({ error: `Dhan returned non-JSON: ${rawText.slice(0, 200)}` }), {
        status: 500, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }

    // Dhan may return token as 'accessToken' or 'access_token' or nested
    const token = data.accessToken || data.access_token || data.data?.accessToken || data.data?.access_token;
    if (!token) {
      return new Response(JSON.stringify({ error: `No access token found. Response keys: ${Object.keys(data).join(', ')}. Full: ${rawText.slice(0, 300)}` }), {
        status: 500, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      accessToken: token,
      clientName: data.dhanClientName || data.data?.dhanClientName || '',
      expiryTime: data.expiryTime || data.data?.expiryTime || '',
    }), {
      status: 200, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Dhan session failed: ${err.message}` }), {
      status: 502, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
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
      if (path === '/dhan/session') {
        return handleDhanSession(request, env, origin);
      }
      if (path === '/dhan/historical') {
        return handleDhanHistorical(request, env, origin);
      }
      if (path === '/dhan/validate') {
        return handleDhanValidate(request, env, origin);
      }
      return new Response('Not found', { status: 404, headers: corsHeaders(origin) });
    }

    // --- GET endpoints ---
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders(origin) });
    }

    // Public-endpoint guard — caps unauthenticated callers at
    // PUBLIC_DAILY_LIMIT/day on the cached read-only routes so a runaway
    // script can't drain the CF Workers free-tier 100k/day budget.
    // Gate-token holders bypass entirely.
    if (PUBLIC_RATE_LIMITED_PATHS.has(path)) {
      const limited = await publicEndpointGuard(request, env, origin);
      if (limited) return limited;
    }

    // Dhan instrument master — called once by client on token connect
    if (path === '/dhan/instruments') {
      return handleDhanInstruments(request, env, origin);
    }

    // Broad Indian news RSS proxy — browser calls this during live scan
    // to build a symbol-sentiment map. We merge multiple Indian publisher
    // feeds (Moneycontrol, LiveMint, Economic Times) into a single payload;
    // the browser parses and scores via newsSentiment.js.
    if (path === '/news/india') {
      return handleIndiaNews(request, env, origin);
    }

    // Google News per-symbol proxy — called for deep lookup on the top
    // ranked candidates after phase 3 so the news layer gets per-stock
    // depth beyond what the broad-feed map provides.
    // Takes ?symbol=RELIANCE (sanitized to alphanumeric + -).
    if (path === '/news/google') {
      return handleGoogleNewsForSymbol(request, env, origin);
    }

    // India VIX live fetch — browser calls this at scan start to get
    // the current VIX close (and thus the current regime).
    if (path === '/market/vix') {
      return handleVixFetch(request, env, origin);
    }

    // NSE FII/DII flow — browser calls this at scan start to get today's
    // institutional flow value. NSE requires a session cookie fetched
    // from the home page first.
    if (path === '/market/fiidii') {
      return handleFiiDiiFetch(request, env, origin);
    }

    // GitHub releases proxy — used as fallback when direct GitHub API is blocked (VPN/CORS)
    if (path === '/github/releases') {
      const repo = url.searchParams.get('repo');
      if (!repo || !/^[\w-]+\/[\w-]+$/.test(repo)) {
        return new Response(JSON.stringify({ error: 'Invalid repo parameter' }), {
          status: 400, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        });
      }
      try {
        const ghResp = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=1`, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'candlescan-proxy' },
        });
        const body = await ghResp.text();
        return new Response(body, {
          status: ghResp.status,
          headers: { ...corsHeaders(origin), 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        });
      }
    }

    // --- GET proxy (Yahoo / NSE) ---
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
