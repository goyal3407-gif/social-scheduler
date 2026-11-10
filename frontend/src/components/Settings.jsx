import { useEffect, useState } from 'react'
import { api } from '../api.js'

const APP_DASHBOARD_URL = 'https://developers.facebook.com/apps/1671693167666941'

export default function Settings({ settings, onSave, saving, onInstagramChanged }) {
  const [handle, setHandle] = useState('')
  const [token, setToken] = useState('')
  const [igUserId, setIgUserId] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  const connected = Boolean(settings?.instagramConnected)
  const username = settings?.instagramUsername || ''
  const maskedToken = settings?.maskedToken || ''
  const tokenSource = settings?.tokenSource || 'none'

  useEffect(() => {
    if (settings) setHandle(settings.instagramHandle || '')
  }, [settings])

  const submitHandle = async (e) => {
    e.preventDefault()
    setErr(''); setMsg('')
    try {
      await onSave({ instagramHandle: handle.trim() })
      setMsg('Settings saved.')
    } catch (e2) {
      setErr(e2.message || 'Could not save settings.')
    }
  }

  const connect = async (e) => {
    e.preventDefault()
    setErr(''); setMsg('')
    if (!token.trim()) { setErr('Paste your access token first.'); return }
    setConnecting(true)
    try {
      const res = await api.connectInstagram(token.trim(), igUserId.trim() || undefined)
      setMsg(res.username ? `Connected as @${res.username}. Token verified with Instagram.` : 'Connected — token verified with Instagram.')
      setToken('')
      if (onInstagramChanged) onInstagramChanged()
    } catch (e2) {
      setErr(e2.message || 'Could not verify this token.')
    } finally { setConnecting(false) }
  }

  const disconnect = async () => {
    setErr(''); setMsg('')
    setDisconnecting(true)
    try {
      const res = await api.disconnectInstagram()
      setMsg(res.instagramConnected
        ? 'Saved token removed. Instagram is still connected via the server environment variables.'
        : 'Instagram disconnected — the saved token was removed.')
      if (onInstagramChanged) onInstagramChanged()
    } catch (e2) {
      setErr(e2.message || 'Could not disconnect.')
    } finally { setDisconnecting(false) }
  }

  return (
    <div>
      <h2 className="section-title">Settings</h2>
      <p className="section-sub">Connect Instagram so “Publish now” can go live. Your token stays on the server — it is never fully displayed here.</p>
      <div className="two-col" style={{ alignItems: 'start' }}>
        <div>
          <form className="card" onSubmit={submitHandle} style={{ marginBottom: 16 }}>
            <h2>Instagram handle</h2>
            <label htmlFor="igHandle" style={{ marginTop: 12 }}>Instagram handle</label>
            <input id="igHandle" placeholder="@yourhandle" value={handle} onChange={(e) => setHandle(e.target.value)} />
            {err && <div className="alert error">{err}</div>}
            {msg && <div className="alert success">{msg}</div>}
            <button type="submit" className="btn primary mt" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
          </form>

          <form className="card" onSubmit={connect}>
            <h2>Connect Instagram</h2>
            <p className="muted small" style={{ marginTop: 8 }}>
              Status: <b style={{ color: 'var(--ink)' }}>{connected ? `Connected${username ? ` as @${username}` : ''}` : 'Not connected'}</b>
              {connected && maskedToken ? ` · token ${maskedToken}` : ''}
              {connected && tokenSource ? ` · via ${tokenSource === 'stored' ? 'saved token' : 'server environment'}` : ''}
            </p>
            <ol className="muted small" style={{ marginTop: 14, paddingLeft: 18, lineHeight: 2 }}>
              <li>Open your Meta app dashboard: <a href={APP_DASHBOARD_URL} target="_blank" rel="noreferrer">developers.facebook.com/apps/1671693167666941</a></li>
              <li>Go to <b style={{ color: 'var(--ink)' }}>API Setup</b> &gt; <b style={{ color: 'var(--ink)' }}>Generate token</b></li>
              <li>Copy the token</li>
              <li>Paste it below and press “Save &amp; test connection”</li>
            </ol>
            <p className="muted small" style={{ marginTop: 10 }}>
              This works for the owner&apos;s own Instagram only — the app is in development mode, so no App Review is needed for your own account.
            </p>
            <label htmlFor="igToken" style={{ marginTop: 14 }}>Access token</label>
            <input id="igToken" type="password" autoComplete="off" placeholder="Paste your Instagram access token" value={token} onChange={(e) => setToken(e.target.value)} />
            <label htmlFor="igUserId" style={{ marginTop: 14 }}>Instagram User ID <span className="muted">(optional if set on the server)</span></label>
            <input id="igUserId" placeholder="e.g. 178414…" value={igUserId} onChange={(e) => setIgUserId(e.target.value)} />
            {err && <div className="alert error">{err}</div>}
            {msg && <div className="alert success">{msg}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              <button type="submit" className="btn primary" disabled={connecting || !token.trim()}>{connecting ? 'Testing…' : 'Save & test connection'}</button>
              {connected && (
                <button type="button" className="btn danger" disabled={disconnecting} onClick={disconnect}>
                  {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </button>
              )}
            </div>
            <p className="muted small mt">The token is checked live with Instagram before it is saved, and stored on the server only. It is never shown in full — only the first and last 4 characters.</p>
          </form>
        </div>
        <section className="card">
          <h2>About this app</h2>
          <p className="muted small" style={{ marginTop: 8 }}>Social Scheduler is free forever. Schedule Reels, Feed posts and Stories for Instagram, YouTube, Facebook and TikTok from one calm place.</p>
          <ul className="muted small" style={{ marginTop: 12, paddingLeft: 18, lineHeight: 1.9 }}>
            <li>Free forever — no trial, no card</li>
            <li>Your media, queue and templates are yours</li>
            <li>Publish live via the Instagram Graph API</li>
            <li>Works on phone and desktop</li>
          </ul>
          <p className="muted small mt">Made by <b style={{ color: 'var(--ink)' }}>Goyal Kumar</b>.</p>
        </section>
      </div>
    </div>
  )
}
