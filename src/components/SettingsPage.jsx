import { useState, useCallback, useRef, useEffect } from 'react';
import { getGateToken, setGateToken, hasGateToken, clearGateToken } from '../utils/batchAuth.js';
import { unlockGate, encryptToVault, getVaultBlob, hasVault, clearGate, getGatePublicKey } from '../utils/credentialVault.js';

const mono = "'SF Mono', Menlo, monospace";
const LS_SOURCE_KEY = 'candlescan_data_source';
const LS_ZERODHA_API_KEY = 'candlescan_zerodha_api_key';
const LS_ZERODHA_API_SECRET = 'candlescan_zerodha_api_secret';
const CF_WORKER_URL = 'https://candlescan-proxy.utkarsh-dev.workers.dev';

function getDataSource() {
  try { return localStorage.getItem(LS_SOURCE_KEY) || 'yahoo'; } catch { return 'yahoo'; }
}
function setDataSource(v) {
  try { localStorage.setItem(LS_SOURCE_KEY, v); } catch { /* quota */ }
}
function getSavedApiKey() {
  try { return localStorage.getItem(LS_ZERODHA_API_KEY) || ''; } catch { return ''; }
}
function getSavedApiSecret() {
  try { return localStorage.getItem(LS_ZERODHA_API_SECRET) || ''; } catch { return ''; }
}

export default function SettingsPage({ onBack, debugMode, onDebugModeChange, mode, onModeChange }) {
  const [gateUnlocked, setGateUnlocked] = useState(hasGateToken());
  const [passphrase, setPassphrase] = useState('');
  const [gateError, setGateError] = useState('');
  const [gateLoading, setGateLoading] = useState(false);

  const [dataSource, setDataSourceState] = useState(getDataSource);
  const [apiKey, setApiKey] = useState(getSavedApiKey);
  const [apiSecret, setApiSecret] = useState(getSavedApiSecret);

  const [vaultSaved, setVaultSaved] = useState(false);
  const [vaultMsg, setVaultMsg] = useState('');
  const [vaultMsgColor, setVaultMsgColor] = useState('#8892a8');
  const [oauthLoading, setOauthLoading] = useState(false);

  const [showPassphrase, setShowPassphrase] = useState(false);
  const [showApiSecret, setShowApiSecret] = useState(false);
  const passphraseRef = useRef(null);

  // Check vault status on mount and when gate state changes
  useEffect(() => {
    try { setVaultSaved(hasVault()); } catch { setVaultSaved(false); }
  }, [gateUnlocked]);

  // Handle OAuth callback — catch request_token from URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestToken = params.get('request_token');
    const action = params.get('action');
    if (requestToken && action === 'login') {
      // Clean URL
      const url = new URL(window.location.href);
      url.searchParams.delete('request_token');
      url.searchParams.delete('action');
      url.searchParams.delete('status');
      window.history.replaceState({}, '', url.toString());

      // Exchange for access token
      const savedKey = getSavedApiKey();
      const savedSecret = getSavedApiSecret();
      if (savedKey && savedSecret && hasGateToken()) {
        exchangeToken(savedKey, savedSecret, requestToken);
      } else {
        setVaultMsg('OAuth callback received but API key/secret not saved. Save them first, then connect.');
        setVaultMsgColor('#dc2626');
      }
    }
  }, []);

  async function exchangeToken(key, secret, requestToken) {
    setOauthLoading(true);
    setVaultMsg('Exchanging token with Zerodha...');
    setVaultMsgColor('#2563eb');
    try {
      const res = await fetch(`${CF_WORKER_URL}/zerodha/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Gate-Token': getGateToken() },
        body: JSON.stringify({ apiKey: key, apiSecret: secret, requestToken }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Session exchange failed (${res.status})`);
      }
      const data = await res.json();
      const accessToken = data.accessToken;
      if (!accessToken) throw new Error('No access token in response');

      // Encrypt all credentials into vault using stored RSA public key
      const pubKey = getGatePublicKey();
      if (!pubKey) throw new Error('RSA public key not found. Re-unlock premium first.');
      await encryptToVault(pubKey, {
        zerodhaApiKey: key,
        zerodhaApiSecret: secret,
        zerodhaAccessToken: accessToken,
      });
      setVaultSaved(true);
      setVaultMsg('Connected! Credentials encrypted & saved.');
      setVaultMsgColor('#16a34a');
    } catch (err) {
      setVaultMsg(err.message || 'Failed to exchange token');
      setVaultMsgColor('#dc2626');
    } finally {
      setOauthLoading(false);
    }
  }

  const handleUnlock = useCallback(async () => {
    if (!passphrase.trim()) return;
    setGateLoading(true);
    setGateError('');
    try {
      await unlockGate(passphrase.trim());
      setGateUnlocked(true);
      setPassphrase('');
    } catch (err) {
      clearGateToken();
      setGateError(err.message || 'Invalid passphrase');
      setGateUnlocked(false);
    } finally {
      setGateLoading(false);
    }
  }, [passphrase]);

  const handleLock = useCallback(() => {
    clearGateToken();
    try { clearGate(); } catch { /* ok */ }
    setGateUnlocked(false);
    setDataSourceState('yahoo');
    setDataSource('yahoo');
    setVaultSaved(false);
  }, []);

  const handleSourceChange = useCallback((src) => {
    setDataSourceState(src);
    setDataSource(src);
  }, []);

  const handleSaveApiKeys = useCallback(() => {
    if (!apiKey.trim() || !apiSecret.trim()) {
      setVaultMsg('Both API Key and API Secret are required');
      setVaultMsgColor('#dc2626');
      return;
    }
    try {
      localStorage.setItem(LS_ZERODHA_API_KEY, apiKey.trim());
      localStorage.setItem(LS_ZERODHA_API_SECRET, apiSecret.trim());
      setVaultMsg('API Key & Secret saved. Now click "Connect Zerodha" to authenticate.');
      setVaultMsgColor('#16a34a');
    } catch {
      setVaultMsg('Failed to save');
      setVaultMsgColor('#dc2626');
    }
  }, [apiKey, apiSecret]);

  const handleConnectZerodha = useCallback(() => {
    const key = apiKey.trim() || getSavedApiKey();
    if (!key) {
      setVaultMsg('Save your API Key first');
      setVaultMsgColor('#dc2626');
      return;
    }
    // Save before redirect so they persist
    if (apiKey.trim() && apiSecret.trim()) {
      try {
        localStorage.setItem(LS_ZERODHA_API_KEY, apiKey.trim());
        localStorage.setItem(LS_ZERODHA_API_SECRET, apiSecret.trim());
      } catch { /* ok */ }
    }
    // Redirect to Zerodha OAuth login
    const redirectUrl = window.location.origin + window.location.pathname;
    window.location.href = `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(key)}&redirect_url=${encodeURIComponent(redirectUrl)}`;
  }, [apiKey, apiSecret]);

  const handleClearVault = useCallback(() => {
    try {
      clearGate();
      localStorage.removeItem(LS_ZERODHA_API_KEY);
      localStorage.removeItem(LS_ZERODHA_API_SECRET);
      setVaultSaved(false);
      setApiKey('');
      setApiSecret('');
      setVaultMsg('Credentials cleared');
      setVaultMsgColor('#8892a8');
    } catch { /* ok */ }
  }, []);

  // eslint-disable-next-line no-undef
  const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';

  const container = { maxWidth: 620, margin: '0 auto', padding: '12px 8px' };
  const card = {
    background: '#fff', border: '1px solid #e2e5eb', borderRadius: 12,
    padding: 16, marginBottom: 16,
  };
  const sectionTitle = {
    fontSize: 11, fontWeight: 700, color: '#8892a8', textTransform: 'uppercase',
    letterSpacing: 0.5, marginBottom: 12, fontFamily: mono,
  };
  const inputStyle = {
    width: '100%', padding: '10px 12px', fontSize: 13, border: '1px solid #e2e5eb',
    borderRadius: 8, outline: 'none', marginBottom: 10, boxSizing: 'border-box',
    fontFamily: mono,
  };
  const btnPrimary = {
    padding: '8px 16px', fontSize: 12, fontWeight: 600, border: 'none',
    borderRadius: 6, cursor: 'pointer', background: '#2563eb', color: '#fff',
  };
  const btnDanger = { ...btnPrimary, background: '#dc2626' };
  const btnSecondary = {
    ...btnPrimary, background: '#f5f6f8', color: '#4a5068', border: '1px solid #e2e5eb',
  };
  const btnZerodha = {
    ...btnPrimary, background: '#387ed1', padding: '10px 20px', fontSize: 13,
  };

  const showZerodha = gateUnlocked && dataSource === 'zerodha';

  return (
    <div style={container}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <button type="button" onClick={onBack}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, fontSize: 20, color: '#4a5068', lineHeight: 1 }}
          aria-label="Go back">&larr;</button>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1a1d26' }}>Settings</h1>
      </div>

      {/* View Mode */}
      {onModeChange && (
        <div style={card}>
          <div style={sectionTitle}>View Mode</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[
              { key: 'simple', label: 'Simple' },
              { key: 'advanced', label: 'Advanced' },
            ].map(opt => (
              <button key={opt.key} type="button"
                onClick={() => { onModeChange(opt.key); try { localStorage.setItem('candlescan_mode', opt.key); } catch {} }}
                style={{
                  flex: 1, padding: '10px 0', fontSize: 12, fontWeight: 600,
                  border: mode === opt.key ? 'none' : '1px solid #e2e5eb',
                  borderRadius: 8, cursor: 'pointer',
                  background: mode === opt.key ? '#2563eb' : '#fff',
                  color: mode === opt.key ? '#fff' : '#4a5068',
                }}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Premium Gate */}
      <div style={card}>
        <div style={sectionTitle}>Premium Gate</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: gateUnlocked ? '#16a34a' : '#dc2626' }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: gateUnlocked ? '#16a34a' : '#dc2626' }}>
            {gateUnlocked ? 'Unlocked' : 'Locked'}
          </span>
        </div>
        {gateUnlocked ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#16a34a', background: '#f0fdf4', borderRadius: 6, padding: '4px 10px' }}>
              Premium Active
            </span>
            <button type="button" onClick={handleLock} style={btnDanger}>Lock</button>
          </div>
        ) : (
          <>
            <div style={{ position: 'relative', marginBottom: 10 }}>
              <input ref={passphraseRef} type={showPassphrase ? 'text' : 'password'} value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
                placeholder="Passphrase" style={{ ...inputStyle, marginBottom: 0, paddingRight: 40 }} />
              <button type="button" onClick={() => setShowPassphrase(v => !v)} tabIndex={-1}
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#8892a8', fontSize: 16, lineHeight: 1 }}
                aria-label={showPassphrase ? 'Hide passphrase' : 'Show passphrase'}>
                {showPassphrase ? '🙈' : '👁'}
              </button>
            </div>
            <button type="button" onClick={handleUnlock}
              disabled={gateLoading || !passphrase.trim()}
              style={{ ...btnPrimary, opacity: gateLoading || !passphrase.trim() ? 0.5 : 1 }}>
              {gateLoading ? 'Unlocking...' : 'Unlock'}
            </button>
            {gateError && <div style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>{gateError}</div>}
          </>
        )}
      </div>

      {/* Data Source */}
      <div style={card}>
        <div style={sectionTitle}>Data Source</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer' }}>
          <input type="radio" name="dataSource" value="yahoo"
            checked={dataSource === 'yahoo'} onChange={() => handleSourceChange('yahoo')} />
          <span style={{ fontSize: 13 }}>Yahoo Finance</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: gateUnlocked ? 'pointer' : 'not-allowed', opacity: gateUnlocked ? 1 : 0.45 }}>
          <input type="radio" name="dataSource" value="zerodha"
            checked={dataSource === 'zerodha'} onChange={() => handleSourceChange('zerodha')}
            disabled={!gateUnlocked} />
          <span style={{ fontSize: 13 }}>
            Zerodha Kite
            <span style={{ fontSize: 10, fontWeight: 600, color: '#2563eb', marginLeft: 6, background: '#eff6ff', borderRadius: 4, padding: '2px 6px' }}>Premium</span>
          </span>
        </label>
      </div>

      {/* Chart Density */}
      {/* Zerodha Setup */}
      {showZerodha && (
        <div style={card}>
          <div style={sectionTitle}>Zerodha Kite Connect</div>

          {/* Step 1: API Key & Secret */}
          <div style={{ fontSize: 12, fontWeight: 600, color: '#4a5068', marginBottom: 8 }}>
            1. Enter your Kite Connect credentials
          </div>
          <input type="text" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder="API Key" style={inputStyle} />
          <div style={{ position: 'relative', marginBottom: 10 }}>
            <input type={showApiSecret ? 'text' : 'password'} value={apiSecret} onChange={(e) => setApiSecret(e.target.value)}
              placeholder="API Secret" style={{ ...inputStyle, marginBottom: 0, paddingRight: 40 }} />
            <button type="button" onClick={() => setShowApiSecret(v => !v)} tabIndex={-1}
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#8892a8', fontSize: 16, lineHeight: 1 }}
              aria-label={showApiSecret ? 'Hide API secret' : 'Show API secret'}>
              {showApiSecret ? '🙈' : '👁'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button type="button" onClick={handleSaveApiKeys} style={btnSecondary}>Save Keys</button>
          </div>

          {/* Step 2: OAuth Connect */}
          <div style={{ fontSize: 12, fontWeight: 600, color: '#4a5068', marginBottom: 8 }}>
            2. Authenticate with Zerodha
          </div>
          <button type="button" onClick={handleConnectZerodha}
            disabled={oauthLoading || (!apiKey.trim() && !getSavedApiKey())}
            style={{ ...btnZerodha, opacity: oauthLoading ? 0.5 : 1, marginBottom: 12 }}>
            {oauthLoading ? 'Connecting...' : vaultSaved ? 'Reconnect Zerodha' : 'Connect Zerodha'}
          </button>
          <div style={{ fontSize: 11, color: '#8892a8', marginBottom: 12 }}>
            Opens Zerodha login. After login, you'll be redirected back and credentials are saved automatically.
            Token expires daily — reconnect each trading day.
          </div>

          {/* Status */}
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: vaultSaved ? '#16a34a' : '#8892a8' }}>
            {vaultSaved ? 'Connected — credentials encrypted & saved' : 'Not connected'}
          </div>

          {vaultMsg && <div style={{ fontSize: 12, color: vaultMsgColor, marginBottom: 6 }}>{vaultMsg}</div>}

          {/* Clear */}
          {vaultSaved && (
            <button type="button" onClick={handleClearVault} style={{ ...btnDanger, marginTop: 8 }}>
              Clear Credentials
            </button>
          )}
        </div>
      )}

      {/* Debug Mode */}
      {onDebugModeChange && (
        <div style={card}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: debugMode ? '#2563eb' : '#4a5068' }}>
            <input type="checkbox" checked={!!debugMode}
              onChange={(e) => onDebugModeChange(e.target.checked)}
              style={{ accentColor: '#2563eb', margin: 0, width: 18, height: 18 }} />
            Debug mode
          </label>
          <div style={{ fontSize: 11, color: '#8892a8', marginTop: 6 }}>
            Shows API call inspector panel at the bottom of the screen.
          </div>
        </div>
      )}

      {/* About */}
      <div style={card}>
        <div style={sectionTitle}>About</div>
        {appVersion && <div style={{ fontSize: 12, color: '#4a5068', marginBottom: 6 }}>Version {appVersion} (pre-release)</div>}
        <div style={{ fontSize: 11, color: '#8892a8', marginBottom: 12 }}>Educational only — not financial advice.</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <a
            href="https://github.com/utkarsh9891/candlescan"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', fontSize: 11, fontWeight: 600, borderRadius: 6,
              border: '1px solid #e2e5eb', background: '#f5f6f8', color: '#4a5068',
              textDecoration: 'none', cursor: 'pointer',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            GitHub
          </a>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event('candlescan:check-update'))}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', fontSize: 11, fontWeight: 600, border: '1px solid #e2e5eb',
              borderRadius: 6, cursor: 'pointer', background: '#f5f6f8', color: '#4a5068',
            }}
          >
            Check for updates
          </button>
        </div>
      </div>
    </div>
  );
}
