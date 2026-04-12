import { useState, useCallback, useEffect } from 'react';
import { getGateToken, hasGateToken } from '../utils/batchAuth.js';
import { encryptToVault, getVaultBlob, hasVault, clearVault, getGatePublicKey } from '../utils/credentialVault.js';
import { fetchDhanInstruments, clearDhanInstruments, getInstrumentsMeta, hasCachedInstruments } from '../engine/dhanInstruments.js';
import PasteInput from './PasteInput.jsx';

const mono = "'SF Mono', Menlo, monospace";
const LS_DHAN_CLIENT_ID = 'candlescan_dhan_client_id';
const LS_DHAN_PIN = 'candlescan_dhan_pin';
const CF_WORKER_URL = 'https://candlescan-proxy.utkarsh-dev.workers.dev';

export default function DhanSettings({ gateUnlocked, dataSource, apiKey, apiSecret, onClearZerodha }) {
  const [dhanClientId, setDhanClientId] = useState(() => {
    try { return localStorage.getItem(LS_DHAN_CLIENT_ID) || ''; } catch { return ''; }
  });
  const [dhanPin, setDhanPin] = useState(() => {
    try { return localStorage.getItem(LS_DHAN_PIN) || ''; } catch { return ''; }
  });
  const [dhanTotp, setDhanTotp] = useState('');
  const [dhanPastedToken, setDhanPastedToken] = useState('');
  const [dhanStatus, setDhanStatus] = useState(() => hasVault() && hasGateToken() ? 'checking' : 'none');
  const [dhanMsg, setDhanMsg] = useState('');
  const [dhanMsgColor, setDhanMsgColor] = useState('#8892a8');
  const [dhanConnecting, setDhanConnecting] = useState(false);
  const [dhanShowAuth, setDhanShowAuth] = useState(false);
  const [refreshingInstruments, setRefreshingInstruments] = useState(false);

  const handleSaveDhanClientId = useCallback(() => {
    if (!dhanClientId.trim()) {
      setDhanMsg('Client ID is required');
      setDhanMsgColor('#dc2626');
      return;
    }
    // Clear Zerodha credentials when configuring Dhan
    onClearZerodha();
    clearVault();
    try { localStorage.setItem(LS_DHAN_CLIENT_ID, dhanClientId.trim()); } catch { /* ok */ }
    setDhanMsg('Client ID saved.');
    setDhanMsgColor('#16a34a');
  }, [dhanClientId, onClearZerodha]);

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
      setDhanMsg(`Connected${data.clientName ? ` — ${data.clientName}` : ''}! Token encrypted. Loading instruments…`);
      setDhanMsgColor('#16a34a');
      setDhanPin('');
      setDhanTotp('');
      setDhanShowAuth(false);
      try {
        const meta = await fetchDhanInstruments(getGateToken());
        setDhanMsg(`Connected! ${meta.count} NSE instruments loaded.`);
      } catch (instrErr) {
        setDhanMsg(`Connected, but instrument list failed: ${instrErr.message}. Tap Refresh instrument list.`);
        setDhanMsgColor('#d97706');
      }
    } catch (err) {
      setDhanMsg(err.message || 'Failed to connect');
      setDhanMsgColor('#dc2626');
    } finally {
      setDhanConnecting(false);
    }
  }, [dhanClientId, dhanPin, dhanTotp, apiKey, apiSecret]);

  const handlePasteToken = useCallback(async () => {
    const token = dhanPastedToken.trim();
    if (!token) { setDhanMsg('Paste an access token first'); setDhanMsgColor('#dc2626'); return; }
    try {
      const pubKey = getGatePublicKey();
      if (!pubKey) throw new Error('RSA public key not found. Re-unlock premium first.');
      await encryptToVault(pubKey, { dhanAccessToken: token });
      setDhanStatus('valid');
      setDhanMsg('Access token encrypted. Loading instruments…');
      setDhanMsgColor('#16a34a');
      setDhanPastedToken('');
      setDhanShowAuth(false);
      try {
        const meta = await fetchDhanInstruments(getGateToken());
        setDhanMsg(`Token saved. ${meta.count} NSE instruments loaded.`);
      } catch (instrErr) {
        setDhanMsg(`Token saved, but instrument list failed: ${instrErr.message}. Tap Refresh instrument list.`);
        setDhanMsgColor('#d97706');
      }
    } catch (err) {
      setDhanMsg(err.message || 'Failed to save token');
      setDhanMsgColor('#dc2626');
    }
  }, [dhanPastedToken]);

  const handleRefreshInstruments = useCallback(async () => {
    const gateToken = getGateToken();
    if (!gateToken) {
      setDhanMsg('Unlock premium first.');
      setDhanMsgColor('#dc2626');
      return;
    }
    setRefreshingInstruments(true);
    setDhanMsg('Refreshing instrument list from Dhan…');
    setDhanMsgColor('#2563eb');
    try {
      const meta = await fetchDhanInstruments(gateToken, { forceRefresh: true });
      setDhanMsg(`Instrument list refreshed: ${meta.count} NSE instruments.`);
      setDhanMsgColor('#16a34a');
    } catch (err) {
      setDhanMsg(`Refresh failed: ${err.message || err}`);
      setDhanMsgColor('#dc2626');
    } finally {
      setRefreshingInstruments(false);
    }
  }, []);

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

  const handleReconnectDhan = useCallback(() => {
    if (dhanStatus === 'valid') {
      const ok = window.confirm('Your current Dhan session is active. Reconnecting will replace it. Continue?');
      if (!ok) return;
    }
    setDhanShowAuth(true);
  }, [dhanStatus]);

  const handleClearDhan = useCallback(() => {
    clearVault();
    clearDhanInstruments();
    try { localStorage.removeItem(LS_DHAN_CLIENT_ID); localStorage.removeItem(LS_DHAN_PIN); } catch { /* ok */ }
    setDhanClientId('');
    setDhanStatus('none');
    setDhanMsg('Credentials cleared. Note: Dhan allows token generation once every 2 minutes.');
    setDhanMsgColor('#d97706');
    setDhanShowAuth(false);
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

  const showDhan = gateUnlocked && dataSource === 'dhan';
  const dhanNeedsAuth = dhanStatus === 'none' || dhanStatus === 'expired' || dhanShowAuth;

  if (!showDhan) return null;

  const card = {
    background: '#fff', border: '1px solid #e2e5eb', borderRadius: 12,
    padding: 16, marginBottom: 16,
  };
  const sectionTitle = {
    fontSize: 11, fontWeight: 700, color: '#8892a8', textTransform: 'uppercase',
    letterSpacing: 0.5, marginBottom: 12, fontFamily: mono,
  };
  const btnPrimary = {
    padding: '8px 16px', fontSize: 12, fontWeight: 600, border: 'none',
    borderRadius: 6, cursor: 'pointer', background: '#2563eb', color: '#fff',
  };
  const btnDanger = { ...btnPrimary, background: '#dc2626' };
  const btnSecondary = {
    ...btnPrimary, background: '#f5f6f8', color: '#4a5068', border: '1px solid #e2e5eb',
  };

  return (
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
        <button type="button" onClick={handleSaveDhanClientId}
          disabled={dhanClientId === ((() => { try { return localStorage.getItem(LS_DHAN_CLIENT_ID) || ''; } catch { return ''; } })())}
          style={{ ...btnSecondary, opacity: dhanClientId === ((() => { try { return localStorage.getItem(LS_DHAN_CLIENT_ID) || ''; } catch { return ''; } })()) ? 0.5 : 1 }}>
          Save
        </button>
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

      {/* Instrument list status */}
      {hasCachedInstruments() && (() => {
        const meta = getInstrumentsMeta();
        if (!meta) return null;
        const fetched = meta.fetchedAt ? new Date(meta.fetchedAt).toLocaleDateString() : 'unknown';
        return (
          <div style={{ fontSize: 11, color: '#8892a8', marginBottom: 8 }}>
            Instrument list: {meta.count} NSE symbols (loaded {fetched})
          </div>
        );
      })()}

      {/* Actions based on state */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {(dhanStatus === 'valid' || dhanStatus === 'checking') && (
          <>
            <button type="button" onClick={handleValidateDhan}
              disabled={dhanStatus === 'checking'}
              style={{ ...btnSecondary, opacity: dhanStatus === 'checking' ? 0.5 : 1 }}>
              {dhanStatus === 'checking' ? 'Validating...' : 'Validate Token'}
            </button>
            <button type="button" onClick={handleRefreshInstruments}
              disabled={refreshingInstruments}
              title="Fetch the latest NSE scrip master from Dhan. Use this if a new listing is missing from the symbol list."
              style={{ ...btnSecondary, opacity: refreshingInstruments ? 0.5 : 1 }}>
              {refreshingInstruments ? 'Refreshing…' : 'Refresh instrument list'}
            </button>
            {!dhanShowAuth && (
              <button type="button" onClick={handleReconnectDhan} style={btnSecondary}>
                Reconnect
              </button>
            )}
            <button type="button" onClick={handleClearDhan} style={btnDanger}>
              Clear Credentials
            </button>
          </>
        )}
      </div>

      {/* Step 2: PIN + TOTP (shown only when needed) */}
      {dhanNeedsAuth && (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#4a5068', marginBottom: 8 }}>
            2a. Authenticate with PIN + TOTP
          </div>
          <div style={{ fontSize: 11, color: '#8892a8', marginBottom: 10 }}>
            Enter your 6-digit Dhan PIN (saved locally) and TOTP from your authenticator app.
          </div>
          <PasteInput value={dhanPin} onChange={(v) => { setDhanPin(v); try { localStorage.setItem(LS_DHAN_PIN, v); } catch { /* ok */ } }} placeholder="Dhan PIN (6 digits)" type="password" useMono />
          <PasteInput value={dhanTotp} onChange={setDhanTotp} placeholder="TOTP (6 digits)" useMono />
          <div style={{ fontSize: 11, color: '#d97706', marginBottom: 8 }}>
            Dhan allows token generation once every 2 minutes.
          </div>
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

          {/* Divider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0' }}>
            <div style={{ flex: 1, height: 1, background: '#e2e5eb' }} />
            <span style={{ fontSize: 11, color: '#8892a8', fontWeight: 600 }}>OR</span>
            <div style={{ flex: 1, height: 1, background: '#e2e5eb' }} />
          </div>

          {/* Paste access token */}
          <div style={{ fontSize: 12, fontWeight: 600, color: '#4a5068', marginBottom: 8 }}>
            2b. Paste access token from web.dhan.co
          </div>
          <div style={{ fontSize: 11, color: '#8892a8', marginBottom: 10 }}>
            Login at web.dhan.co → My Profile → Access DhanHQ APIs → copy the token.
          </div>
          <PasteInput value={dhanPastedToken} onChange={setDhanPastedToken} placeholder="Paste access token" useMono />
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button type="button" onClick={handlePasteToken}
              disabled={!dhanPastedToken.trim()}
              style={{ ...btnPrimary, background: '#387ed1', opacity: !dhanPastedToken.trim() ? 0.5 : 1 }}>
              Save Token
            </button>
          </div>
        </>
      )}
    </div>
  );
}
