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
async function resolveDhanSecurityId(symbol, env) {
  const KV_KEY = 'dhan_nse_instruments';
  const sym = symbol.toUpperCase();

  if (env.CANDLESCAN_KV) {
    const cached = await env.CANDLESCAN_KV.get(KV_KEY, 'json');
    if (cached && cached[sym]) return cached[sym];
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
    // Only NSE equities
    if (exch !== 'NSE' || (instr !== 'EQUITY' && instr !== 'INDEX')) continue;
    const tradingSym = (cols[symIdx] || '').replace(/"/g, '').trim();
    const secId = (cols[secIdIdx] || '').trim();
    if (tradingSym && secId) map[tradingSym] = secId;
  }

  if (env.CANDLESCAN_KV) {
    try { await env.CANDLESCAN_KV.put(KV_KEY, JSON.stringify(map), { expirationTtl: 86400 }); } catch { /* ok */ }
  }

  if (!map[sym]) throw new Error(`Symbol "${sym}" not found in Dhan NSE instruments`);
  return map[sym];
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
  const { symbol, interval, from, to, vault, dhanClientId } = body;

  if (!symbol || !interval || !from || !to || !vault) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), {
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

  // Resolve symbol to securityId
  let securityId;
  try {
    securityId = await resolveDhanSecurityId(symbol, env);
  } catch (err) {
    return new Response(JSON.stringify({ error: `Instrument lookup failed: ${err.message}` }), {
      status: 400, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  }

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
      candles.push({
        t: Math.floor(new Date(timestamps[i]).getTime() / 1000),
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
