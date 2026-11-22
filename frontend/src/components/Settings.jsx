import { lazy, Suspense, useEffect, useState } from 'react'
import { openExternalUrl } from '../openExternal.js'
import { api } from '../api.js'
import { StatusChip } from './shared.jsx'

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
    <section className="card settings-card-top">
      <h2>{t('bioTitle')}</h2>
      <p className="muted small" style={{ marginTop: 8 }}>{t('bioSub')}</p>
      <label htmlFor="bioSlug" style={{ marginTop: 12 }}>{t('bioPageName')}</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="muted small">/bio/</span>
        <input id="bioSlug" placeholder="yourname" value={slug} onChange={(e) => setSlug(e.target.value)} style={{ flex: 1 }} />
      </div>
      <label className="check-row">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
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
        {enabled && pageUrl && <a className="btn ghost" href={pageUrl} target="_blank" rel="noreferrer" onClick={(e) => { if (openExternalUrl(new URL(pageUrl, window.location.origin).href)) e.preventDefault() }}>{t('openPage')}</a>}
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
    <section className="card settings-card-top">
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
    <section className="card settings-card-top">
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
        <div className="alert error" role="alert">
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
        <div className="alert success" role="status">
          {t('dbOk')}
        </div>
      )}
      {/* Round 3 (B7): Settings grouped under visible headings —
          Profile / Security / Preferences / Team. */}
      <h3 className="settings-group-title">{t('profileTitle')}</h3>
      <section className="card settings-card-gap">
        <h2>{t('accountTitle')}</h2>
        <p className="muted small settings-note-top">{t('signedInAs')} <b style={{ color: 'var(--ink)' }}>{user?.email || '—'}</b>{user?.name ? ` · ${user.name}` : ''}{user?.role ? ` · ${user.role}` : ''}</p>
      </section>

      <form className="card settings-card-gap" onSubmit={submitHandle}>
            <h2>{t('igHandleTitle')}</h2>
            <label htmlFor="igHandle" className="settings-field-gap">{t('igHandleTitle')}</label>
            <input id="igHandle" placeholder="@yourhandle" value={handle} onChange={(e) => setHandle(e.target.value)} />
            {err && <div className="alert error">{err}</div>}
            {msg && <div className="alert success">{msg}</div>}
            <button type="submit" className="btn primary mt" disabled={saving}>{saving ? t('savingWord') : t('saveSettingsBtn')}</button>
          </form>

          <div className="card">
            <h2>{t('connections')}</h2>
            <div className="settings-note-top">
              <StatusChip platform="instagram" state={connected ? 'connected' : 'off'} label={connected ? `${username ? t('statusConnectedAs').replace('{name}', username) : t('connected')}${igAccountCount > 1 ? ` ${t('accountsCountSuffix').replace('{n}', igAccountCount)}` : ''}` : undefined} />
            </div>
            <p className="muted small settings-note-top">
              {t('settingsConnNote')}
            </p>
            <div className="settings-inline-note">
              <button type="button" className="btn primary" onClick={() => { if (onNavigate) onNavigate('connections') }}>{t('manageConnections')}</button>
            </div>
          </div>

      <h3 className="settings-group-title">{t('securityTitle')}</h3>
      <form className="card settings-card-gap" onSubmit={changePassword}>
          <h2>{t('changePassword')}</h2>
          <p className="muted small settings-note-6">{t('changePwNote')}</p>
          <label htmlFor="currentPw" className="settings-field-gap">{t('currentPassword')}</label>
          <input id="currentPw" type="password" autoComplete="current-password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} />
          <label htmlFor="newPw" className="settings-field-gap">{t('newPassword')}</label>
          <input id="newPw" type="password" autoComplete="new-password" placeholder={t('pwPh')} value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          {pwErr && <div className="alert error">{pwErr}</div>}
          {pwMsg && <div className="alert success">{pwMsg}</div>}
          <button type="submit" className="btn primary mt" disabled={pwBusy || !currentPw || newPw.length < 8}>{pwBusy ? t('changingWord') : t('changePassword')}</button>
      </form>

        <section className="card">
          <h2>{t('yourDataTitle')}</h2>
          <div className="settings-actions-row">
            <button type="button" className="btn ghost" disabled={exporting} onClick={exportData}>{exporting ? t('exportingWord') : t('downloadData')}</button>
          </div>
          <p className="muted small mt">{t('exportNote')}</p>
          <hr className="settings-hr" />
          <h3 className="settings-danger-title">{t('deleteAccountTitle')}</h3>
          <p className="muted small settings-note-6">{t('deleteAccountBody')}</p>
          {!confirmDeleteAccount ? (
            <button type="button" className="btn danger mt" onClick={() => setConfirmDeleteAccount(true)}>{t('deleteMyAccount')}</button>
          ) : (
            <div className="settings-actions-row">
              <button type="button" className="btn danger" disabled={deletingAccount} onClick={deleteAccount}>{deletingAccount ? t('deletingWord') : t('yesDeleteAll')}</button>
              <button type="button" className="btn ghost" onClick={() => setConfirmDeleteAccount(false)}>{t('cancel')}</button>
            </div>
          )}
        </section>

      <h3 className="settings-group-title">{t('preferencesTitle')}</h3>
          <div className="card">
            <p className="muted small">
              {t('storageExplain')}
            </p>
            <label className="check-row check-row-start">
              <input type="checkbox" checked={settings?.keepServerCopyAfterPublish === true} disabled={saving}
                onChange={async (e) => { setErr(''); setMsg(''); try { await onSave({ keepServerCopyAfterPublish: e.target.checked }); setMsg(t('storageSaved')) } catch (e2) { setErr(e2.message || t('settingsSaveFail')) } }} />
              <span><b>{t('keepCopyTitle')}</b><br /><span className="muted small">{t('keepCopyNote')}</span></span>
            </label>
            <h3 className="settings-subhead">{t('ytDefaultTitle')}</h3>
            <p className="muted small settings-note-6">{t('ytDefaultNote')}</p>
            <select aria-label={t('ytDefaultTitle')} value={settings?.ytDefaultVisibility || 'public'} disabled={saving} className="settings-select"
              onChange={async (e) => { setErr(''); setMsg(''); try { await onSave({ ytDefaultVisibility: e.target.value }); setMsg(t('ytDefaultSaved')) } catch (e2) { setErr(e2.message || t('settingsSaveFail')) } }}>
              <option value="public">{t('ytVisPublic')}</option>
              <option value="unlisted">{t('ytVisUnlisted')}</option>
              <option value="private">{t('ytVisPrivate')}</option>
            </select>
            <p className="muted small settings-note-6">{t('ytApprovalShort')}</p>
            <p className="muted small settings-note-12">{t('notifHomeNote')}</p>
            <h3 className="settings-subhead">{t('appLanguage')}</h3>
            <p className="muted small settings-note-6">{t('appLanguageNote')}</p>
            <div className="settings-lang-row">
              <button type="button" className={`btn small ${lang !== 'hi' ? 'primary' : 'ghost'}`} onClick={() => onLangChange && onLangChange('en')}>{t('englishWord')}</button>
              <button type="button" className={`btn small ${lang === 'hi' ? 'primary' : 'ghost'}`} onClick={() => onLangChange && onLangChange('hi')}>{t('hinglishWord')}</button>
            </div>
          </div>

      <BioCard tr={t} />
      <PreviewCard tr={t} />
      <InviteCard tr={t} />
      {/* Team group: TeamCard carries its own visible "Team"
          heading and renders nothing at all on non-Ultra plans,
          so no separate group title is printed here (it would
          orphan for every non-Ultra user). */}
      <Suspense fallback={null}><TeamCard tr={tr} /></Suspense>

      <section className="card settings-card-top">
        <h2>{t('supportTitle')}</h2>
        <p className="muted small settings-note-top">{t('supportSub')}</p>
        <p className="settings-note-10"><a href="/contact.html">{t('contactUs')}</a></p>
      </section>

        <section className="card settings-card-top">
          <h2>{t('aboutTitle')}</h2>
          <p className="muted small settings-note-top">{t('aboutBody')}</p>
          <ul className="muted small settings-list">
            <li>{t('aboutFree')}</li>
            <li>{t('aboutYours')}</li>
            <li>{t('aboutApi')}</li>
            <li>{t('aboutDevices')}</li>
          </ul>
          {/* Prompt-3: the full YouTube-visibility explanation lives
              here on the help surface — the composer keeps only the
              one short line (ytApprovalShort). */}
          <h3 className="settings-subhead">{t('helpYtTitle')}</h3>
          <p className="muted small settings-note-6">{t('helpYtBody')}</p>
        </section>
    </div>
  )
}
