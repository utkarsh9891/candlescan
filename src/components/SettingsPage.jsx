import { useState, useCallback, useRef, useEffect } from 'react';
import { getGateToken, setGateToken, hasGateToken, clearGateToken } from '../utils/batchAuth.js';
import { unlockGate, encryptToVault, getVaultBlob, hasVault, clearVault, clearGate, getGatePublicKey } from '../utils/credentialVault.js';
import PasteInput from './PasteInput.jsx';

const mono = "'SF Mono', Menlo, monospace";
const LS_SOURCE_KEY = 'candlescan_data_source';
const LS_ZERODHA_API_KEY = 'candlescan_zerodha_api_key';
const LS_ZERODHA_API_SECRET = 'candlescan_zerodha_api_secret';
const LS_DHAN_CLIENT_ID = 'candlescan_dhan_client_id';
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

export default function SettingsPage({ onBack, debugMode, onDebugModeChange }) {
  const [gateUnlocked, setGateUnlocked] = useState(hasGateToken());
  const [passphrase, setPassphrase] = useState('');
  const [gateError, setGateError] = useState('');
  const [gateLoading, setGateLoading] = useState(false);

  const [dataSource, setDataSourceState] = useState(getDataSource);
  const [apiKey, setApiKey] = useState(getSavedApiKey);
  const [apiSecret, setApiSecret] = useState(getSavedApiSecret);

  // tokenStatus: 'none' | 'checking' | 'valid' | 'expired'
  const [tokenStatus, setTokenStatus] = useState(() => hasVault() ? 'checking' : 'none');
  const [tokenUserName, setTokenUserName] = useState('');
  const [vaultMsg, setVaultMsg] = useState('');
  const [vaultMsgColor, setVaultMsgColor] = useState('#8892a8');
  const [oauthLoading, setOauthLoading] = useState(false);

  const [showPassphrase, setShowPassphrase] = useState(false);
  const passphraseRef = useRef(null);

  // Derived for backward compat in UI logic
  const vaultSaved = tokenStatus === 'valid' || tokenStatus === 'checking';

  // Validate token on mount — informational only, never auto-clears vault.
  // Only scan-time failures should clear the vault (definitive proof token is dead).
  useEffect(() => {
    if (!hasVault() || !hasGateToken()) {
      setTokenStatus('none');
      return;
    }
    if (dataSource !== 'zerodha') {
      setTokenStatus('valid');
      return;
    }
    let cancelled = false;
    (async () => {
      setTokenStatus('checking');
      try {
        const vault = getVaultBlob();
        const gateToken = getGateToken();
        if (!vault || !gateToken) { if (!cancelled) setTokenStatus('none'); return; }
        const res = await fetch(`${CF_WORKER_URL}/zerodha/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Gate-Token': gateToken },
          body: JSON.stringify({ vault }),
        });
        if (cancelled) return;
        const data = await res.json();
        if (data.valid) {
          setTokenStatus('valid');
          setTokenUserName(data.userName || '');
        } else {
          // Show expired status but do NOT clear vault — let scan-time handle cleanup
          setTokenStatus('expired');
          setVaultMsg('Token expired. Click "Connect Zerodha" to re-authenticate.');
          setVaultMsgColor('#dc2626');
        }
      } catch {
        // Network/parse error — assume valid
        if (!cancelled) setTokenStatus('valid');
      }
    })();
    return () => { cancelled = true; };
  }, [gateUnlocked, dataSource]);

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
      setTokenStatus('valid');
      setTokenUserName('');
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
    setTokenStatus('none');
    setTokenUserName('');
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
    // If token is currently valid, confirm before invalidating
    if (tokenStatus === 'valid') {
      const ok = window.confirm('Your current Zerodha session is active. Reconnecting will invalidate it. Continue?');
      if (!ok) return;
    }
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
    // Redirect to Zerodha OAuth login — use replace() so the Zerodha URL
    // doesn't stay in browser history (back button should return to home, not Zerodha)
    const redirectUrl = window.location.origin + window.location.pathname;
    window.location.replace(`https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(key)}&redirect_url=${encodeURIComponent(redirectUrl)}`);
  }, [apiKey, apiSecret, tokenStatus]);

  const handleClearVault = useCallback(() => {
    try {
      clearGate();
      localStorage.removeItem(LS_ZERODHA_API_KEY);
      localStorage.removeItem(LS_ZERODHA_API_SECRET);
      setTokenStatus('none');
      setTokenUserName('');
      setApiKey('');
      setApiSecret('');
      setVaultMsg('Credentials cleared');
      setVaultMsgColor('#8892a8');
    } catch { /* ok */ }
  }, []);

  const handleValidateToken = useCallback(async () => {
    if (!hasVault() || !hasGateToken()) {
      setVaultMsg('No credentials to validate');
      setVaultMsgColor('#dc2626');
      return;
    }
    setTokenStatus('checking');
    setVaultMsg('');
    try {
      const vault = getVaultBlob();
      const gateToken = getGateToken();
      const res = await fetch(`${CF_WORKER_URL}/zerodha/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Gate-Token': gateToken },
        body: JSON.stringify({ vault }),
      });
      const data = await res.json();
      if (data.valid) {
        setTokenStatus('valid');
        setTokenUserName(data.userName || '');
        setVaultMsg('Token is valid');
        setVaultMsgColor('#16a34a');
      } else {
        setTokenStatus('expired');
        setVaultMsg(`Validation failed: ${data.error || 'token invalid'}`);
        setVaultMsgColor('#dc2626');
      }
    } catch (err) {
      setVaultMsg(`Network error: ${err.message}`);
      setVaultMsgColor('#dc2626');
    }
  }, []);

  // ─── Dhan ───────────────────────────────────────────────────────────
  const [dhanClientId, setDhanClientId] = useState(() => {
    try { return localStorage.getItem(LS_DHAN_CLIENT_ID) || ''; } catch { return ''; }
  });
  const [dhanPin, setDhanPin] = useState('');
  const [dhanTotp, setDhanTotp] = useState('');
  const [dhanStatus, setDhanStatus] = useState(() => hasVault() && hasGateToken() ? 'checking' : 'none');
  const [dhanMsg, setDhanMsg] = useState('');
  const [dhanMsgColor, setDhanMsgColor] = useState('#8892a8');
  const [dhanConnecting, setDhanConnecting] = useState(false);
  const [dhanShowAuth, setDhanShowAuth] = useState(false); // Toggle PIN+TOTP fields

  const handleSaveDhanClientId = useCallback(() => {
    if (!dhanClientId.trim()) {
      setDhanMsg('Client ID is required');
      setDhanMsgColor('#dc2626');
      return;
    }
    try { localStorage.setItem(LS_DHAN_CLIENT_ID, dhanClientId.trim()); } catch { /* ok */ }
    setDhanMsg('Client ID saved.');
    setDhanMsgColor('#16a34a');
  }, [dhanClientId]);

  const handleConnectDhan = useCallback(async () => {
    const clientId = dhanClientId.trim() || ((() => { try { return localStorage.getItem(LS_DHAN_CLIENT_ID) || ''; } catch { return ''; } })());
    if (!clientId) { setDhanMsg('Save your Client ID first'); setDhanMsgColor('#dc2626'); return; }
    if (!dhanPin.trim()) { setDhanMsg('PIN is required'); setDhanMsgColor('#dc2626'); return; }
    if (!dhanTotp.trim()) { setDhanMsg('TOTP is required'); setDhanMsgColor('#dc2626'); return; }

    setDhanConnecting(true);
    setDhanMsg('Generating access token...');
    setDhanMsgColor('#2563eb');
    try {
      const gateToken = getGateToken();
      const res = await fetch(`${CF_WORKER_URL}/dhan/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Gate-Token': gateToken },
        body: JSON.stringify({ dhanClientId: clientId, pin: dhanPin.trim(), totp: dhanTotp.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Session failed (${res.status})`);
      }
      const data = await res.json();
      if (!data.accessToken) throw new Error('No access token in response');

      // Encrypt access token into vault
      const pubKey = getGatePublicKey();
      if (!pubKey) throw new Error('RSA public key not found. Re-unlock premium first.');
      const existing = {};
      if (apiKey.trim()) existing.zerodhaApiKey = apiKey.trim();
      if (apiSecret.trim()) existing.zerodhaApiSecret = apiSecret.trim();
      await encryptToVault(pubKey, { ...existing, dhanAccessToken: data.accessToken });

      setDhanStatus('valid');
      setDhanMsg(`Connected${data.clientName ? ` — ${data.clientName}` : ''}! Token encrypted & saved.`);
      setDhanMsgColor('#16a34a');
      setDhanPin('');
      setDhanTotp('');
      setDhanShowAuth(false);
    } catch (err) {
      setDhanMsg(err.message || 'Failed to connect');
      setDhanMsgColor('#dc2626');
    } finally {
      setDhanConnecting(false);
    }
  }, [dhanClientId, dhanPin, dhanTotp, apiKey, apiSecret]);

  const handleValidateDhan = useCallback(async () => {
    if (!hasVault() || !hasGateToken()) {
      setDhanMsg('No credentials to validate');
      setDhanMsgColor('#dc2626');
      return;
    }
    setDhanStatus('checking');
    setDhanMsg('');
    try {
      const vault = getVaultBlob();
      const gateToken = getGateToken();
      const res = await fetch(`${CF_WORKER_URL}/dhan/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Gate-Token': gateToken },
        body: JSON.stringify({ vault }),
      });
      const data = await res.json();
      if (data.valid) {
        setDhanStatus('valid');
        setDhanMsg('Token is valid');
        setDhanMsgColor('#16a34a');
      } else {
        setDhanStatus('expired');
        setDhanMsg(`Validation failed: ${data.error || 'token invalid'}`);
        setDhanMsgColor('#dc2626');
      }
    } catch (err) {
      setDhanMsg(`Network error: ${err.message}`);
      setDhanMsgColor('#dc2626');
    }
  }, []);

  // Auto-validate Dhan token on mount when vault exists and Dhan selected
  useEffect(() => {
    if (dataSource !== 'dhan' || !hasVault() || !hasGateToken()) {
      if (dataSource === 'dhan') setDhanStatus('none');
      return;
    }
    let cancelled = false;
    (async () => {
      setDhanStatus('checking');
      try {
        const vault = getVaultBlob();
        const gateToken = getGateToken();
        if (!vault || !gateToken) { if (!cancelled) setDhanStatus('none'); return; }
        const clientId = (() => { try { return localStorage.getItem(LS_DHAN_CLIENT_ID) || ''; } catch { return ''; } })();
        const res = await fetch(`${CF_WORKER_URL}/dhan/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Gate-Token': gateToken },
          body: JSON.stringify({ vault, dhanClientId: clientId }),
        });
        if (cancelled) return;
        const data = await res.json();
        if (data.valid) {
          setDhanStatus('valid');
        } else {
          setDhanStatus('expired');
          setDhanMsg('Token expired — reconnect with PIN + TOTP');
          setDhanMsgColor('#dc2626');
        }
      } catch {
        if (!cancelled) setDhanStatus('valid'); // Network error — assume valid
      }
    })();
    return () => { cancelled = true; };
  }, [gateUnlocked, dataSource]);

  const handleReconnectDhan = useCallback(() => {
    if (dhanStatus === 'valid') {
      const ok = window.confirm('Your current Dhan session is active. Reconnecting will replace it. Continue?');
      if (!ok) return;
    }
    setDhanShowAuth(true);
  }, [dhanStatus]);

  const handleClearDhan = useCallback(() => {
    clearVault();
    try { localStorage.removeItem(LS_DHAN_CLIENT_ID); } catch { /* ok */ }
    setDhanClientId('');
    setDhanStatus('none');
    setDhanMsg('Credentials cleared');
    setDhanMsgColor('#8892a8');
    setDhanShowAuth(false);
  }, []);

  const showDhan = gateUnlocked && dataSource === 'dhan';
  // Show PIN+TOTP fields when: not connected, expired, or user clicked reconnect
  const dhanNeedsAuth = dhanStatus === 'none' || dhanStatus === 'expired' || dhanShowAuth;

  // eslint-disable-next-line no-undef
  // Version now shown only in hamburger menu

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

      {/* View Mode toggle removed — single advanced mode */
      false && (
        <div style={card} />
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
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: gateUnlocked ? 'pointer' : 'not-allowed', opacity: gateUnlocked ? 1 : 0.45 }}>
          <input type="radio" name="dataSource" value="zerodha"
            checked={dataSource === 'zerodha'} onChange={() => handleSourceChange('zerodha')}
            disabled={!gateUnlocked} />
          <span style={{ fontSize: 13 }}>
            Zerodha Kite
            <span style={{ fontSize: 10, fontWeight: 600, color: '#2563eb', marginLeft: 6, background: '#eff6ff', borderRadius: 4, padding: '2px 6px' }}>Premium</span>
          </span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: gateUnlocked ? 'pointer' : 'not-allowed', opacity: gateUnlocked ? 1 : 0.45 }}>
          <input type="radio" name="dataSource" value="dhan"
            checked={dataSource === 'dhan'} onChange={() => handleSourceChange('dhan')}
            disabled={!gateUnlocked} />
          <span style={{ fontSize: 13 }}>
            Dhan
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
          <PasteInput value={apiKey} onChange={setApiKey} placeholder="API Key" useMono />
          <PasteInput value={apiSecret} onChange={setApiSecret} placeholder="API Secret" type="password" useMono />
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
          <div style={{
            fontSize: 11, color: '#92400e', background: '#fefce8', border: '1px solid #fde68a',
            borderRadius: 6, padding: '8px 10px', marginBottom: 12, lineHeight: 1.5,
          }}>
            Requires the <strong>Historical Data add-on</strong> (included in the Rs 2,000/month Kite Connect plan).
            Without it, scans will fall back to Yahoo Finance.
          </div>

          {/* Status */}
          <div style={{
            fontSize: 12, fontWeight: 600, marginBottom: 6,
            color: tokenStatus === 'valid' ? '#16a34a'
              : tokenStatus === 'expired' ? '#dc2626'
              : tokenStatus === 'checking' ? '#d97706'
              : '#8892a8',
          }}>
            {tokenStatus === 'valid' && `Connected — token verified${tokenUserName ? ` (${tokenUserName})` : ''}`}
            {tokenStatus === 'checking' && 'Checking token...'}
            {tokenStatus === 'expired' && 'Token expired — click "Connect Zerodha" to re-authenticate'}
            {tokenStatus === 'none' && 'Not connected'}
          </div>

          {vaultMsg && <div style={{ fontSize: 12, color: vaultMsgColor, marginBottom: 6 }}>{vaultMsg}</div>}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            {hasVault() && (
              <button type="button" onClick={handleValidateToken}
                disabled={tokenStatus === 'checking'}
                style={{ ...btnSecondary, opacity: tokenStatus === 'checking' ? 0.5 : 1 }}>
                {tokenStatus === 'checking' ? 'Validating...' : 'Validate Token'}
              </button>
            )}
            {(tokenStatus === 'valid' || tokenStatus === 'checking') && (
              <button type="button" onClick={handleClearVault} style={btnDanger}>
                Clear Credentials
              </button>
            )}
          </div>
        </div>
      )}

      {/* Dhan Setup */}
      {showDhan && (
        <div style={card}>
          <div style={sectionTitle}>Dhan Connect</div>
          <div style={{
            fontSize: 11, color: '#92400e', background: '#fefce8', border: '1px solid #fde68a',
            borderRadius: 6, padding: '8px 10px', marginBottom: 12, lineHeight: 1.5,
          }}>
            Requires the <strong>DhanHQ Data API subscription</strong> (Rs 499/month) and <strong>TOTP enabled</strong> on your Dhan account.
            Without the Data API, scans will fall back to Yahoo Finance.
          </div>

          {/* Step 1: Client ID (saved) */}
          <div style={{ fontSize: 12, fontWeight: 600, color: '#4a5068', marginBottom: 8 }}>
            1. Dhan Client ID
          </div>
          <PasteInput value={dhanClientId} onChange={setDhanClientId} placeholder="Dhan Client ID" useMono />
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button type="button" onClick={handleSaveDhanClientId} style={btnSecondary}>Save</button>
          </div>

          {/* Status */}
          <div style={{
            fontSize: 12, fontWeight: 600, marginBottom: 8,
            color: dhanStatus === 'valid' ? '#16a34a'
              : dhanStatus === 'expired' ? '#dc2626'
              : dhanStatus === 'checking' ? '#d97706'
              : '#8892a8',
          }}>
            {dhanStatus === 'valid' && 'Connected — token verified'}
            {dhanStatus === 'checking' && 'Checking token...'}
            {dhanStatus === 'expired' && 'Token expired'}
            {dhanStatus === 'none' && 'Not connected'}
          </div>

          {dhanMsg && <div style={{ fontSize: 12, color: dhanMsgColor, marginBottom: 8 }}>{dhanMsg}</div>}

          {/* Actions based on state */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {(dhanStatus === 'valid' || dhanStatus === 'checking') && (
              <>
                <button type="button" onClick={handleValidateDhan}
                  disabled={dhanStatus === 'checking'}
                  style={{ ...btnSecondary, opacity: dhanStatus === 'checking' ? 0.5 : 1 }}>
                  {dhanStatus === 'checking' ? 'Validating...' : 'Validate Token'}
                </button>
                <button type="button" onClick={handleReconnectDhan} style={btnSecondary}>
                  Reconnect
                </button>
                <button type="button" onClick={handleClearDhan} style={btnDanger}>
                  Clear Credentials
                </button>
              </>
            )}
            {dhanStatus === 'none' && !dhanShowAuth && (
              <button type="button" onClick={() => setDhanShowAuth(true)}
                style={{ ...btnPrimary, background: '#387ed1' }}>
                Connect Dhan
              </button>
            )}
            {dhanStatus === 'expired' && !dhanShowAuth && (
              <button type="button" onClick={() => setDhanShowAuth(true)}
                style={{ ...btnPrimary, background: '#387ed1' }}>
                Reconnect
              </button>
            )}
          </div>

          {/* Step 2: PIN + TOTP (shown only when needed) */}
          {dhanNeedsAuth && (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#4a5068', marginBottom: 8 }}>
                2. Authenticate with PIN + TOTP
              </div>
              <div style={{ fontSize: 11, color: '#8892a8', marginBottom: 10 }}>
                Enter your 6-digit Dhan PIN and TOTP from your authenticator app. Neither is stored.
              </div>
              <PasteInput value={dhanPin} onChange={setDhanPin} placeholder="Dhan PIN (6 digits)" type="password" useMono />
              <PasteInput value={dhanTotp} onChange={setDhanTotp} placeholder="TOTP (6 digits)" useMono />
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <button type="button" onClick={handleConnectDhan}
                  disabled={dhanConnecting}
                  style={{ ...btnPrimary, background: '#387ed1', opacity: dhanConnecting ? 0.5 : 1 }}>
                  {dhanConnecting ? 'Connecting...' : 'Connect'}
                </button>
                {dhanShowAuth && (dhanStatus === 'valid' || dhanStatus === 'checking') && (
                  <button type="button" onClick={() => { setDhanShowAuth(false); setDhanPin(''); setDhanTotp(''); }}
                    style={btnSecondary}>
                    Cancel
                  </button>
                )}
              </div>
            </>
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
        <div style={{ fontSize: 12, color: '#4a5068', marginBottom: 4 }}>
          {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'v?'} (pre-release)
        </div>
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
