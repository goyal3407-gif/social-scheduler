import { useEffect, useState } from 'react'
import { api } from '../api.js'

export default function Settings({ settings, dbStatus, onSave, saving, onInstagramChanged, user, onAccountDeleted, onNavigate }) {
  const [handle, setHandle] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwMsg, setPwMsg] = useState('')
  const [pwErr, setPwErr] = useState('')
  const [exporting, setExporting] = useState(false)
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false)
  const [deletingAccount, setDeletingAccount] = useState(false)

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

  const igAccountCount = Array.isArray(settings?.instagramAccounts) ? settings.instagramAccounts.length : 0

  return (
    <div className="settings-col">
      <h2 className="section-title">Settings</h2>
      <p className="section-sub">Your account, Instagram connection and preferences — all in one place.</p>
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
      <section className="card" style={{ marginBottom: 16 }}>
        <h2>Account</h2>
        <p className="muted small" style={{ marginTop: 8 }}>Signed in as <b style={{ color: 'var(--ink)' }}>{user?.email || '—'}</b>{user?.name ? ` · ${user.name}` : ''}{user?.role ? ` · ${user.role}` : ''}</p>
        <form onSubmit={changePassword}>
          <h3 style={{ marginTop: 18 }}>Change password</h3>
          <p className="muted small" style={{ marginTop: 6 }}>Changing your password logs out your other devices.</p>
          <label htmlFor="currentPw" style={{ marginTop: 12 }}>Current password</label>
          <input id="currentPw" type="password" autoComplete="current-password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} />
          <label htmlFor="newPw" style={{ marginTop: 12 }}>New password</label>
          <input id="newPw" type="password" autoComplete="new-password" placeholder="At least 8 characters" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          {pwErr && <div className="alert error">{pwErr}</div>}
          {pwMsg && <div className="alert success">{pwMsg}</div>}
          <button type="submit" className="btn primary mt" disabled={pwBusy || !currentPw || newPw.length < 8}>{pwBusy ? 'Changing…' : 'Change password'}</button>
        </form>
      </section>

      <form className="card" onSubmit={submitHandle} style={{ marginBottom: 16 }}>
            <h2>Instagram handle</h2>
            <label htmlFor="igHandle" style={{ marginTop: 12 }}>Instagram handle</label>
            <input id="igHandle" placeholder="@yourhandle" value={handle} onChange={(e) => setHandle(e.target.value)} />
            {err && <div className="alert error">{err}</div>}
            {msg && <div className="alert success">{msg}</div>}
            <button type="submit" className="btn primary mt" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
          </form>

          <div className="card">
            <h2>Connections</h2>
            <p className="muted small" style={{ marginTop: 8 }}>
              Instagram: <b style={{ color: 'var(--ink)' }}>{connected ? `Connected${username ? ` as @${username}` : ''}${igAccountCount > 1 ? ` (${igAccountCount} accounts)` : ''}` : 'Not connected'}</b>
            </p>
            <p className="muted small" style={{ marginTop: 8 }}>
              Instagram and YouTube linking now lives on the Connections page — connect, set the default account, or disconnect there.
            </p>
            <div style={{ marginTop: 14 }}>
              <button type="button" className="btn primary" onClick={() => { if (onNavigate) onNavigate('connections') }}>Manage connections</button>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h2>Preferences</h2>
            <p className="muted small" style={{ marginTop: 8 }}>
              The server only holds an uploaded file until Instagram publishes it — after a successful post, the server copy is deleted automatically to save space (the post stays live on Instagram, and the library entry is marked “Published — server copy removed”). Files still needed by scheduled posts are never deleted, and media added by link is never touched.
            </p>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={settings?.keepServerCopyAfterPublish === true} disabled={saving}
                onChange={async (e) => { setErr(''); setMsg(''); try { await onSave({ keepServerCopyAfterPublish: e.target.checked }); setMsg('Storage setting saved.') } catch (e2) { setErr(e2.message || 'Could not save settings.') } }}
                style={{ width: 18, height: 18, marginTop: 2, flex: 'none' }} />
              <span><b>Keep a server copy after publishing</b><br /><span className="muted small">Off by default. Turn it on if you want to reuse the same file for more posts later — it uses more storage.</span></span>
            </label>
            <p className="muted small" style={{ marginTop: 12 }}>Publish results — successes and failures with their reasons — appear under Notifications on the Home screen, and failures are also flagged on the post itself.</p>
          </div>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>Support</h2>
        <p className="muted small" style={{ marginTop: 8 }}>Questions, feedback or a problem with your account?</p>
        <p style={{ marginTop: 10 }}><a href="/contact.html">Contact us →</a></p>
      </section>

        <section className="card" style={{ marginTop: 16 }}>
          <h2>Your data &amp; account</h2>
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

        <section className="card" style={{ marginTop: 16 }}>
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
  )
}
