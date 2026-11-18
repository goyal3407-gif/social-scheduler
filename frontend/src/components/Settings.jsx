import { useEffect, useState } from 'react'
import { api } from '../api.js'

async function copyText(text, setCopied) {
  try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }
  catch { setCopied(false) }
}

// D6: link-in-bio page — slug + on/off + up to 10 links.
function BioCard() {
  const [slug, setSlug] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [links, setLinks] = useState([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let alive = true
    api.getBio().then((r) => {
      if (!alive || !r || !r.bio) return
      setSlug(r.bio.slug || ''); setEnabled(!!r.bio.enabled); setLinks(Array.isArray(r.bio.links) ? r.bio.links : [])
    }).catch(() => {})
    return () => { alive = false }
  }, [])
  const save = async () => {
    setBusy(true); setError(''); setNote('')
    try {
      const r = await api.saveBio({ slug: slug.trim().toLowerCase(), enabled, links })
      setNote(enabled ? 'Your page is live.' : 'Saved — your page is switched off.')
      if (r && r.bio) { setSlug(r.bio.slug || ''); setLinks(r.bio.links || []) }
    } catch (e) { setError(e.message || 'Could not save your page.') }
    finally { setBusy(false) }
  }
  const pageUrl = slug ? `${window.location.origin}/bio/${slug}` : ''
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h2>Link-in-bio page</h2>
      <p className="muted small" style={{ marginTop: 8 }}>One public page with your links and your latest published posts — put it in your Instagram bio. No login needed to view it.</p>
      <label htmlFor="bioSlug" style={{ marginTop: 12 }}>Page name</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="muted small">/bio/</span>
        <input id="bioSlug" placeholder="yourname" value={slug} onChange={(e) => setSlug(e.target.value)} style={{ flex: 1 }} />
      </div>
      <label style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, cursor: 'pointer' }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ width: 18, height: 18 }} />
        <span><b>Page is on</b> <span className="muted small">(off = the link shows “not available”)</span></span>
      </label>
      <h3 style={{ marginTop: 16 }}>Your links</h3>
      {links.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <input placeholder="Title (e.g. My shop)" value={l.title} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} style={{ flex: 1 }} />
          <input placeholder="https://…" value={l.url} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} style={{ flex: 1.4 }} />
          <button type="button" className="btn ghost small" onClick={() => setLinks(links.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      {links.length < 10 && <button type="button" className="btn ghost small" style={{ marginTop: 10 }} onClick={() => setLinks([...links, { title: '', url: '' }])}>+ Add a link</button>}
      {error && <div className="alert error" style={{ marginTop: 10 }}>{error}</div>}
      {note && <div className="alert success" style={{ marginTop: 10 }}>{note}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save page'}</button>
        {enabled && pageUrl && <button type="button" className="btn ghost" onClick={() => copyText(pageUrl, setCopied)}>{copied ? 'Copied!' : 'Copy page link'}</button>}
        {enabled && pageUrl && <a className="btn ghost" href={pageUrl} target="_blank" rel="noreferrer">Open page</a>}
      </div>
    </section>
  )
}

// D8: preview / approval link — signed, read-only, revocable.
function PreviewCard() {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let alive = true
    api.getPreviewLink().then((r) => { if (alive && r) setUrl(r.url || '') }).catch(() => {})
    return () => { alive = false }
  }, [])
  const run = async (fn) => {
    setBusy(true); setError('')
    try { const r = await fn(); setUrl((r && r.url) || '') }
    catch (e) { setError(e.message || 'Could not update the preview link.') }
    finally { setBusy(false) }
  }
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h2>Client preview link</h2>
      <p className="muted small" style={{ marginTop: 8 }}>Share a read-only page of your upcoming scheduled posts so a client can approve them — no login needed. Making a new link kills the old one.</p>
      {url ? (
        <>
          <p className="small" style={{ marginTop: 10, wordBreak: 'break-all' }}>{url}</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn ghost" onClick={() => copyText(url, setCopied)}>{copied ? 'Copied!' : 'Copy link'}</button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => run(() => api.regeneratePreviewLink())}>Make a new link (old one stops working)</button>
          </div>
        </>
      ) : (
        <button type="button" className="btn primary" style={{ marginTop: 12 }} disabled={busy} onClick={() => run(() => api.createPreviewLink())}>{busy ? 'Creating…' : 'Create preview link'}</button>
      )}
      {error && <div className="alert error" style={{ marginTop: 10 }}>{error}</div>}
    </section>
  )
}

// D11: referrals — code + link + joined count. No reward promises.
function InviteCard() {
  const [data, setData] = useState(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let alive = true
    api.getReferral().then((r) => { if (alive && r && r.ok) setData(r) }).catch(() => {})
    return () => { alive = false }
  }, [])
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h2>Invite friends</h2>
      <p className="muted small" style={{ marginTop: 8 }}>Share your link — friends who sign up through it are counted here. Invites are tracked now; rewards arrive with Pro.</p>
      {data ? (
        <>
          <p style={{ marginTop: 12 }}><b>Your invites: {data.count} friend{data.count === 1 ? '' : 's'} joined</b></p>
          <p className="small" style={{ marginTop: 8, wordBreak: 'break-all' }}>{data.link}</p>
          <button type="button" className="btn ghost" style={{ marginTop: 10 }} onClick={() => copyText(data.link, setCopied)}>{copied ? 'Copied!' : 'Copy invite link'}</button>
        </>
      ) : (
        <p className="muted small" style={{ marginTop: 10 }}>Loading your invite link…</p>
      )}
    </section>
  )
}

export default function Settings({ settings, dbStatus, onSave, saving, onInstagramChanged, user, onAccountDeleted, onNavigate, lang, onLangChange }) {
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
            <h3 style={{ marginTop: 18 }}>App language</h3>
            <p className="muted small" style={{ marginTop: 6 }}>Switch the app&rsquo;s menus and headings between English and Hinglish. Your captions and posts are never changed.</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" className={`btn small ${lang !== 'hi' ? 'primary' : 'ghost'}`} onClick={() => onLangChange && onLangChange('en')}>English</button>
              <button type="button" className={`btn small ${lang === 'hi' ? 'primary' : 'ghost'}`} onClick={() => onLangChange && onLangChange('hi')}>Hinglish</button>
            </div>
          </div>

      <BioCard />
      <PreviewCard />
      <InviteCard />

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
