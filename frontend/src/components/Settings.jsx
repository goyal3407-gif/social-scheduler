import { lazy, Suspense, useEffect, useState } from 'react'
import { api } from '../api.js'

const TeamCard = lazy(() => import('./TeamCard.jsx'))

async function copyText(text, setCopied) {
  try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }
  catch { setCopied(false) }
}

// D6: link-in-bio page — slug + on/off + up to 10 links.
function BioCard({ tr }) {
  const t = tr || ((k) => k)
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
      setNote(enabled ? t('bioLive') : t('bioSavedOff'))
      if (r && r.bio) { setSlug(r.bio.slug || ''); setLinks(r.bio.links || []) }
    } catch (e) { setError(e.message || t('bioSaveFail')) }
    finally { setBusy(false) }
  }
  const pageUrl = slug ? `${window.location.origin}/bio/${slug}` : ''
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h2>{t('bioTitle')}</h2>
      <p className="muted small" style={{ marginTop: 8 }}>{t('bioSub')}</p>
      <label htmlFor="bioSlug" style={{ marginTop: 12 }}>{t('bioPageName')}</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="muted small">/bio/</span>
        <input id="bioSlug" placeholder="yourname" value={slug} onChange={(e) => setSlug(e.target.value)} style={{ flex: 1 }} />
      </div>
      <label style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, cursor: 'pointer' }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ width: 18, height: 18 }} />
        <span><b>{t('bioPageOn')}</b> <span className="muted small">{t('bioOffNote')}</span></span>
      </label>
      <h3 style={{ marginTop: 16 }}>{t('bioYourLinks')}</h3>
      {links.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <input placeholder={t('bioLinkTitlePh')} value={l.title} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} style={{ flex: 1 }} />
          <input placeholder="https://…" value={l.url} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} style={{ flex: 1.4 }} />
          <button type="button" className="btn ghost small" onClick={() => setLinks(links.filter((_, j) => j !== i))}>{t('remove')}</button>
        </div>
      ))}
      {links.length < 10 && <button type="button" className="btn ghost small" style={{ marginTop: 10 }} onClick={() => setLinks([...links, { title: '', url: '' }])}>{t('bioAddLink')}</button>}
      {error && <div className="alert error" style={{ marginTop: 10 }}>{error}</div>}
      {note && <div className="alert success" style={{ marginTop: 10 }}>{note}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? t('savingWord') : t('bioSavePage')}</button>
        {enabled && pageUrl && <button type="button" className="btn ghost" onClick={() => copyText(pageUrl, setCopied)}>{copied ? t('copiedWord') : t('copyPageLink')}</button>}
        {enabled && pageUrl && <a className="btn ghost" href={pageUrl} target="_blank" rel="noreferrer">{t('openPage')}</a>}
      </div>
    </section>
  )
}

// D8: preview / approval link — signed, read-only, revocable.
function PreviewCard({ tr }) {
  const t = tr || ((k) => k)
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
    catch (e) { setError(e.message || t('previewFail')) }
    finally { setBusy(false) }
  }
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h2>{t('previewTitle')}</h2>
      <p className="muted small" style={{ marginTop: 8 }}>{t('previewSub')}</p>
      {url ? (
        <>
          <p className="small" style={{ marginTop: 10, wordBreak: 'break-all' }}>{url}</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn ghost" onClick={() => copyText(url, setCopied)}>{copied ? t('copiedWord') : t('copyLink')}</button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => run(() => api.regeneratePreviewLink())}>{t('previewNewLink')}</button>
          </div>
        </>
      ) : (
        <button type="button" className="btn primary" style={{ marginTop: 12 }} disabled={busy} onClick={() => run(() => api.createPreviewLink())}>{busy ? t('creatingWord') : t('previewCreate')}</button>
      )}
      {error && <div className="alert error" style={{ marginTop: 10 }}>{error}</div>}
    </section>
  )
}

// D11: referrals — code + link + joined count. No reward promises.
function InviteCard({ tr }) {
  const t = tr || ((k) => k)
  const [data, setData] = useState(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let alive = true
    api.getReferral().then((r) => { if (alive && r && r.ok) setData(r) }).catch(() => {})
    return () => { alive = false }
  }, [])
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h2>{t('inviteTitle')}</h2>
      <p className="muted small" style={{ marginTop: 8 }}>{t('inviteSub')}</p>
      {data ? (
        <>
          <p style={{ marginTop: 12 }}><b>{t(data.count === 1 ? 'invitesCountOne' : 'invitesCountMany').replace('{n}', data.count)}</b></p>
          <p className="small" style={{ marginTop: 8, wordBreak: 'break-all' }}>{data.link}</p>
          <button type="button" className="btn ghost" style={{ marginTop: 10 }} onClick={() => copyText(data.link, setCopied)}>{copied ? t('copiedWord') : t('copyInviteLink')}</button>
        </>
      ) : (
        <p className="muted small" style={{ marginTop: 10 }}>{t('inviteLoading')}</p>
      )}
    </section>
  )
}

export default function Settings({ settings, dbStatus, onSave, saving, onInstagramChanged, user, onAccountDeleted, onNavigate, lang, onLangChange, tr }) {
  const t = tr || ((k) => k)
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
    if (newPw.length < 8) { setPwErr(t('pwTooShort')); return }
    setPwBusy(true)
    try {
      await api.changePassword(currentPw, newPw)
      setPwMsg(t('pwChanged'))
      setCurrentPw(''); setNewPw('')
    } catch (e2) { setPwErr(e2.message || t('pwChangeFail')) }
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
      setMsg(t('dataDownloaded'))
    } catch (e2) { setErr(e2.message || t('exportFail')) }
    finally { setExporting(false) }
  }

  const deleteAccount = async () => {
    setDeletingAccount(true)
    try {
      await api.deleteAccount()
      if (onAccountDeleted) onAccountDeleted()
    } catch (e2) {
      setErr(e2.message || t('deleteAccountFail'))
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
      setMsg(t('settingsSaved'))
    } catch (e2) {
      setErr(e2.message || t('settingsSaveFail'))
    }
  }

  const igAccountCount = Array.isArray(settings?.instagramAccounts) ? settings.instagramAccounts.length : 0

  return (
    <div className="settings-col">
      <h2 className="section-title">{t('settings')}</h2>
      <p className="section-sub">{t('settingsSub')}</p>
      {dbStatus && (dbStatus.db !== 'mongodb' || !dbStatus.sessionSecretFromEnv) && (
        <div className="alert error" role="alert" style={{ marginBottom: 16 }}>
          <b>{t('serverAttention')}</b>{' '}
          {dbStatus.db !== 'mongodb'
            ? `${t('dbTempBody')} `
            : ''}
          {!dbStatus.sessionSecretFromEnv
            ? t('sessionBody')
            : ''}
          {dbStatus.lastError ? ` ${t('lastDbError')} ${dbStatus.lastError}` : ''}
        </div>
      )}
      {dbStatus && dbStatus.db === 'mongodb' && dbStatus.sessionSecretFromEnv && (
        <div className="alert success" role="status" style={{ marginBottom: 16 }}>
          {t('dbOk')}
        </div>
      )}
      <section className="card" style={{ marginBottom: 16 }}>
        <h2>{t('accountTitle')}</h2>
        <p className="muted small" style={{ marginTop: 8 }}>{t('signedInAs')} <b style={{ color: 'var(--ink)' }}>{user?.email || '—'}</b>{user?.name ? ` · ${user.name}` : ''}{user?.role ? ` · ${user.role}` : ''}</p>
        <form onSubmit={changePassword}>
          <h3 style={{ marginTop: 18 }}>{t('changePassword')}</h3>
          <p className="muted small" style={{ marginTop: 6 }}>{t('changePwNote')}</p>
          <label htmlFor="currentPw" style={{ marginTop: 12 }}>{t('currentPassword')}</label>
          <input id="currentPw" type="password" autoComplete="current-password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} />
          <label htmlFor="newPw" style={{ marginTop: 12 }}>{t('newPassword')}</label>
          <input id="newPw" type="password" autoComplete="new-password" placeholder={t('pwPh')} value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          {pwErr && <div className="alert error">{pwErr}</div>}
          {pwMsg && <div className="alert success">{pwMsg}</div>}
          <button type="submit" className="btn primary mt" disabled={pwBusy || !currentPw || newPw.length < 8}>{pwBusy ? t('changingWord') : t('changePassword')}</button>
        </form>
      </section>

      <form className="card" onSubmit={submitHandle} style={{ marginBottom: 16 }}>
            <h2>{t('igHandleTitle')}</h2>
            <label htmlFor="igHandle" style={{ marginTop: 12 }}>{t('igHandleTitle')}</label>
            <input id="igHandle" placeholder="@yourhandle" value={handle} onChange={(e) => setHandle(e.target.value)} />
            {err && <div className="alert error">{err}</div>}
            {msg && <div className="alert success">{msg}</div>}
            <button type="submit" className="btn primary mt" disabled={saving}>{saving ? t('savingWord') : t('saveSettingsBtn')}</button>
          </form>

          <div className="card">
            <h2>{t('connections')}</h2>
            <p className="muted small" style={{ marginTop: 8 }}>
              Instagram: <b style={{ color: 'var(--ink)' }}>{connected ? `${username ? t('statusConnectedAs').replace('{name}', username) : t('connected')}${igAccountCount > 1 ? ` ${t('accountsCountSuffix').replace('{n}', igAccountCount)}` : ''}` : t('notConnected')}</b>
            </p>
            <p className="muted small" style={{ marginTop: 8 }}>
              {t('settingsConnNote')}
            </p>
            <div style={{ marginTop: 14 }}>
              <button type="button" className="btn primary" onClick={() => { if (onNavigate) onNavigate('connections') }}>{t('manageConnections')}</button>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h2>{t('preferencesTitle')}</h2>
            <p className="muted small" style={{ marginTop: 8 }}>
              {t('storageExplain')}
            </p>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={settings?.keepServerCopyAfterPublish === true} disabled={saving}
                onChange={async (e) => { setErr(''); setMsg(''); try { await onSave({ keepServerCopyAfterPublish: e.target.checked }); setMsg(t('storageSaved')) } catch (e2) { setErr(e2.message || t('settingsSaveFail')) } }}
                style={{ width: 18, height: 18, marginTop: 2, flex: 'none' }} />
              <span><b>{t('keepCopyTitle')}</b><br /><span className="muted small">{t('keepCopyNote')}</span></span>
            </label>
            <h3 style={{ marginTop: 18 }}>{t('ytDefaultTitle')}</h3>
            <p className="muted small" style={{ marginTop: 6 }}>{t('ytDefaultNote')}</p>
            <select aria-label={t('ytDefaultTitle')} value={settings?.ytDefaultVisibility || 'public'} disabled={saving} style={{ marginTop: 10, maxWidth: 320 }}
              onChange={async (e) => { setErr(''); setMsg(''); try { await onSave({ ytDefaultVisibility: e.target.value }); setMsg(t('ytDefaultSaved')) } catch (e2) { setErr(e2.message || t('settingsSaveFail')) } }}>
              <option value="public">{t('ytVisPublic')}</option>
              <option value="unlisted">{t('ytVisUnlisted')}</option>
              <option value="private">{t('ytVisPrivate')}</option>
            </select>
            <p className="muted small" style={{ marginTop: 6 }}>{t('ytApprovalShort')}</p>
            <p className="muted small" style={{ marginTop: 12 }}>{t('notifHomeNote')}</p>
            <h3 style={{ marginTop: 18 }}>{t('appLanguage')}</h3>
            <p className="muted small" style={{ marginTop: 6 }}>{t('appLanguageNote')}</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" className={`btn small ${lang !== 'hi' ? 'primary' : 'ghost'}`} onClick={() => onLangChange && onLangChange('en')}>{t('englishWord')}</button>
              <button type="button" className={`btn small ${lang === 'hi' ? 'primary' : 'ghost'}`} onClick={() => onLangChange && onLangChange('hi')}>{t('hinglishWord')}</button>
            </div>
          </div>

      <BioCard tr={t} />
      <PreviewCard tr={t} />
      <InviteCard tr={t} />
      <Suspense fallback={null}><TeamCard tr={tr} /></Suspense>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>{t('supportTitle')}</h2>
        <p className="muted small" style={{ marginTop: 8 }}>{t('supportSub')}</p>
        <p style={{ marginTop: 10 }}><a href="/contact.html">{t('contactUs')}</a></p>
      </section>

        <section className="card" style={{ marginTop: 16 }}>
          <h2>{t('yourDataTitle')}</h2>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button type="button" className="btn ghost" disabled={exporting} onClick={exportData}>{exporting ? t('exportingWord') : t('downloadData')}</button>
          </div>
          <p className="muted small mt">{t('exportNote')}</p>
          <hr style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '18px 0' }} />
          <h3 style={{ color: 'var(--red-text)' }}>{t('deleteAccountTitle')}</h3>
          <p className="muted small" style={{ marginTop: 6 }}>{t('deleteAccountBody')}</p>
          {!confirmDeleteAccount ? (
            <button type="button" className="btn danger mt" onClick={() => setConfirmDeleteAccount(true)}>{t('deleteMyAccount')}</button>
          ) : (
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <button type="button" className="btn danger" disabled={deletingAccount} onClick={deleteAccount}>{deletingAccount ? t('deletingWord') : t('yesDeleteAll')}</button>
              <button type="button" className="btn ghost" onClick={() => setConfirmDeleteAccount(false)}>{t('cancel')}</button>
            </div>
          )}
        </section>

        <section className="card" style={{ marginTop: 16 }}>
          <h2>{t('aboutTitle')}</h2>
          <p className="muted small" style={{ marginTop: 8 }}>{t('aboutBody')}</p>
          <ul className="muted small" style={{ marginTop: 12, paddingLeft: 18, lineHeight: 1.9 }}>
            <li>{t('aboutFree')}</li>
            <li>{t('aboutYours')}</li>
            <li>{t('aboutApi')}</li>
            <li>{t('aboutDevices')}</li>
          </ul>
        </section>
    </div>
  )
}
