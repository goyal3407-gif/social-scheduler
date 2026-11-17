import { useEffect, useState } from 'react'
import { api, openInstagramConnect, openInstagramDirectConnect } from '../api.js'

export default function Settings({ settings, dbStatus, onSave, saving, onInstagramChanged, user, onAccountDeleted }) {
  const [handle, setHandle] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [connectBusy, setConnectBusy] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwMsg, setPwMsg] = useState('')
  const [pwErr, setPwErr] = useState('')
  const [exporting, setExporting] = useState(false)
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false)
  const [deletingAccount, setDeletingAccount] = useState(false)

  // Connection health comes from the server (instagramHealth): the token's
  // real expiry from Meta, and whether the keeper has renewed it. The app
  // renews the token automatically before it expires — the user only has
  // to act if Meta has actually revoked the connection (needsReconnect).
  const health = settings?.instagramHealth || null
  const healthUntil = health?.tokenExpiresAt ? new Date(health.tokenExpiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null
  const healthRenewed = health?.lastRefreshAt ? new Date(health.lastRefreshAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null

  const changePassword = async (e) => {
    e.preventDefault()
    setPwErr(''); setPwMsg('')
    if (newPw.length < 8) { setPwErr('The new password must be at least 8 characters long.'); return }
    setPwBusy(true)
    try {
      await api.changePassword(currentPw, newPw)
      setPwMsg('Password changed — other devices were logged out.')
      setCurrentPw(''); setNewPw('')
    } catch (e2) { setPwErr(e2.message || 'Could not change the password.') }
    finally { setPwBusy(false) }
  }

  const exportData = async () => {
    setExporting(true)
    try {
      const data = await api.exportData()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'social-scheduler-export.json'
      a.click()
      URL.revokeObjectURL(a.href)
      setMsg('Your data was downloaded as social-scheduler-export.json.')
    } catch (e2) { setErr(e2.message || 'Could not export your data.') }
    finally { setExporting(false) }
  }

  const deleteAccount = async () => {
    setDeletingAccount(true)
    try {
      await api.deleteAccount()
      if (onAccountDeleted) onAccountDeleted()
    } catch (e2) {
      setErr(e2.message || 'Could not delete the account.')
      setDeletingAccount(false)
      setConfirmDeleteAccount(false)
    }
  }

  const connected = Boolean(settings?.instagramConnected)
  const username = settings?.instagramUsername || ''

  useEffect(() => {
    if (settings) setHandle(settings.instagramHandle || '')
  }, [settings])

  // The Meta login finishes in the system browser (in the app) or in
  // this tab's past — either way, when the user comes BACK to this
  // screen, refresh the connection state so it flips to "Connected" on
  // its own, with no manual reload.
  useEffect(() => {
    if (!onInstagramChanged) return undefined
    const refresh = () => { onInstagramChanged() }
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', refresh)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', refresh)
    }
  }, [onInstagramChanged])

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

  const startConnect = async () => {
    setErr(''); setMsg('')
    setConnectBusy(true)
    try {
      await openInstagramDirectConnect()
      // In the app, the Instagram login is now open in the system
      // browser and this screen stays put; in a web browser this tab
      // has navigated away. The focus/visibility refresh above updates
      // the status when the user returns.
      setMsg('Instagram login opened — approve access there, then come back here. This screen updates itself when you return.')
    } finally { setConnectBusy(false) }
  }

  const startFacebookConnect = async () => {
    setErr(''); setMsg('')
    setConnectBusy(true)
    try {
      await openInstagramConnect()
      setMsg('Facebook login opened — approve access there, then come back here. This screen updates itself when you return.')
    } finally { setConnectBusy(false) }
  }

  const disconnect = async () => {
    setErr(''); setMsg('')
    setDisconnecting(true)
    try {
      const res = await api.disconnectInstagram()
      setMsg(res.instagramConnected
        ? 'Saved connection removed. Instagram is still connected via the server environment.'
        : 'Instagram disconnected.')
      if (onInstagramChanged) onInstagramChanged()
    } catch (e2) {
      setErr(e2.message || 'Could not disconnect.')
    } finally { setDisconnecting(false) }
  }

  return (
    <div>
      <h2 className="section-title">Settings</h2>
      <p className="section-sub">Connect Instagram so “Publish now” can go live. One login with Instagram — the connection is kept on the server and renews itself automatically.</p>
      {dbStatus && (dbStatus.db !== 'mongodb' || !dbStatus.sessionSecretFromEnv) && (
        <div className="alert error" role="alert" style={{ marginBottom: 16 }}>
          <b>Server setup needs attention.</b>{' '}
          {dbStatus.db !== 'mongodb'
            ? 'Accounts and posts are stored in temporary files right now and will disappear when the site redeploys. Set MONGODB_URI in Vercel → Project Settings → Environment Variables (all environments), then redeploy. '
            : ''}
          {!dbStatus.sessionSecretFromEnv
            ? 'SESSION_SECRET is not set, so logins will not survive a restart or redeploy. Set SESSION_SECRET in Vercel → Project Settings → Environment Variables (all environments), then redeploy.'
            : ''}
          {dbStatus.lastError ? ` Last database error: ${dbStatus.lastError}` : ''}
        </div>
      )}
      {dbStatus && dbStatus.db === 'mongodb' && dbStatus.sessionSecretFromEnv && (
        <div className="alert success" role="status" style={{ marginBottom: 16 }}>
          Database connected (MongoDB) and logins survive redeploys.
        </div>
      )}
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

          <div className="card">
            <h2>Connect Instagram</h2>
            <p className="muted small" style={{ marginTop: 8 }}>
              Status: <b style={{ color: 'var(--ink)' }}>{connected ? `Connected${username ? ` as @${username}` : ''}` : 'Not connected'}</b>
            </p>
            {connected && health && !health.needsReconnect && (
              <p className="muted small" style={{ marginTop: 8 }}>
                {health.tokenNeverExpires
                  ? 'This connection does not expire — no renewal needed, ever.'
                  : healthUntil
                    ? <>Valid until <b style={{ color: 'var(--ink)' }}>{healthUntil}</b>{health.daysRemaining !== null ? ` (${health.daysRemaining} days)` : ''} — and it <b style={{ color: 'var(--ink)' }}>renews itself automatically</b> before that date. You never need to reconnect.</>
                    : 'This connection renews itself automatically — you never need to reconnect.'}
                {healthRenewed ? ` Last auto-renewed ${healthRenewed}.` : ''}
              </p>
            )}
            {connected && health?.needsReconnect && (
              <div className="alert error" style={{ marginTop: 12 }}><b>Instagram ended this connection.</b> Meta revoked it (for example a password change, or access removed in your Meta settings), so automatic renewal can&apos;t save it. Use the Connect Instagram button below to log in again — that&apos;s the only time you ever need to reconnect.</div>
            )}
            {connected && health?.refreshBlocked && !health.needsReconnect && (
              <div className="warn amber" style={{ marginTop: 12 }}><div><b>Automatic renewal could not run for this connection.</b> The app will keep checking, but if it reaches its expiry date you will need to reconnect once with the button below.{(health.lastDebugError || health.lastRefreshError) ? <> Meta&apos;s reason: <i>{health.lastRefreshError || health.lastDebugError}</i></> : ''}</div></div>
            )}
            <p className="muted small" style={{ marginTop: 14 }}>
              One login with Instagram. Instagram opens its own login page, you approve access once, and from then on the connection <b style={{ color: 'var(--ink)' }}>renews itself automatically</b>. Your Instagram must be a Business or Creator account — no Facebook account needed.
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <button type="button" className="btn primary" disabled={connectBusy} onClick={startConnect}>
                {connectBusy ? 'Opening Instagram login…' : connected ? 'Reconnect Instagram' : 'Connect Instagram'}
              </button>
              <button type="button" className="btn ghost" disabled={connectBusy} onClick={startFacebookConnect}>
                or connect via Facebook
              </button>
              {connected && (
                <button type="button" className="btn danger" disabled={disconnecting} onClick={disconnect}>
                  {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </button>
              )}
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>
              Connecting via Facebook uses Meta&apos;s Facebook login instead, and needs your Instagram linked to a Facebook Page.
            </p>
            {err && <div className="alert error">{err}</div>}
            {msg && <div className="alert success">{msg}</div>}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h2>Storage</h2>
            <p className="muted small" style={{ marginTop: 8 }}>
              The server only holds an uploaded file until Instagram publishes it — after a successful post, the server copy is deleted automatically to save space (the post stays live on Instagram, and the library entry is marked “Published — server copy removed”). Files still needed by scheduled posts are never deleted, and media added by link is never touched.
            </p>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={settings?.keepServerCopyAfterPublish === true} disabled={saving}
                onChange={async (e) => { setErr(''); setMsg(''); try { await onSave({ keepServerCopyAfterPublish: e.target.checked }); setMsg('Storage setting saved.') } catch (e2) { setErr(e2.message || 'Could not save settings.') } }}
                style={{ width: 18, height: 18, marginTop: 2, flex: 'none' }} />
              <span><b>Keep a server copy after publishing</b><br /><span className="muted small">Off by default. Turn it on if you want to reuse the same file for more posts later — it uses more storage.</span></span>
            </label>
          </div>
        </div>
        <section className="card">
          <h2>About this app</h2>
          <p className="muted small" style={{ marginTop: 8 }}>KiluaAI is free forever. Schedule Reels, Feed posts and Stories for Instagram, YouTube, Facebook and TikTok from one calm place.</p>
          <ul className="muted small" style={{ marginTop: 12, paddingLeft: 18, lineHeight: 1.9 }}>
            <li>Free forever — no trial, no card</li>
            <li>Your media, queue and templates are yours</li>
            <li>Publish live via the Instagram Graph API</li>
            <li>Works on phone and desktop</li>
          </ul>
        </section>
      </div>

      <div className="two-col section" style={{ alignItems: 'start' }}>
        <form className="card" onSubmit={changePassword}>
          <h2>Change password</h2>
          <p className="muted small" style={{ marginTop: 8 }}>Changing your password logs out your other devices.</p>
          <label htmlFor="currentPw" style={{ marginTop: 12 }}>Current password</label>
          <input id="currentPw" type="password" autoComplete="current-password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} />
          <label htmlFor="newPw" style={{ marginTop: 12 }}>New password</label>
          <input id="newPw" type="password" autoComplete="new-password" placeholder="At least 8 characters" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          {pwErr && <div className="alert error">{pwErr}</div>}
          {pwMsg && <div className="alert success">{pwMsg}</div>}
          <button type="submit" className="btn primary mt" disabled={pwBusy || !currentPw || newPw.length < 8}>{pwBusy ? 'Changing…' : 'Change password'}</button>
        </form>

        <section className="card">
          <h2>Your data &amp; account</h2>
          <p className="muted small" style={{ marginTop: 8 }}>Signed in as <b style={{ color: 'var(--ink)' }}>{user?.email || '—'}</b>{user?.role ? ` · ${user.role}` : ''}.</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button type="button" className="btn ghost" disabled={exporting} onClick={exportData}>{exporting ? 'Exporting…' : 'Download my data (JSON)'}</button>
          </div>
          <p className="muted small mt">The export contains your posts, media, templates and settings. Your Instagram connection details are never included.</p>
          <hr style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '18px 0' }} />
          <h3 style={{ color: 'var(--red)' }}>Delete account</h3>
          <p className="muted small" style={{ marginTop: 6 }}>Permanently deletes your account and everything in it — posts, media, templates, settings and your Instagram connection. This cannot be undone.</p>
          {!confirmDeleteAccount ? (
            <button type="button" className="btn danger mt" onClick={() => setConfirmDeleteAccount(true)}>Delete my account…</button>
          ) : (
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <button type="button" className="btn danger" disabled={deletingAccount} onClick={deleteAccount}>{deletingAccount ? 'Deleting…' : 'Yes, delete everything'}</button>
              <button type="button" className="btn ghost" onClick={() => setConfirmDeleteAccount(false)}>Cancel</button>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
