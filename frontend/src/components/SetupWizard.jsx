import { useEffect, useRef, useState } from 'react'
import { api, openInstagramConnect, openInstagramDirectConnect } from '../api.js'

// Three-step setup wizard shown after first login (ONE flow — batch 5
// merged the old Dashboard GuideWizard into this one so the step count
// and list are the same everywhere):
// 1. Connect Instagram (direct Instagram Login; Facebook login as the
//    secondary route for Page-linked accounts).
// 2. Import the connected account's profile + existing posts.
// 3. Create the first post (hands over to the Studio).
// Followers and DMs cannot be imported — Meta does not allow it.
// Any step can be skipped.
export default function SetupWizard({ settings, onDone, onInstagramChanged, onCreateFirst, tr }) {
  const t = tr || ((k) => k)
  const [step, setStep] = useState(settings?.instagramConnected ? 2 : 1)
  const [connectBusy, setConnectBusy] = useState(false)
  const [connectMsg, setConnectMsg] = useState('')
  const [err, setErr] = useState('')
  const [importing, setImporting] = useState(false)
  const [job, setJob] = useState(null)
  const [finishing, setFinishing] = useState(false)
  const pollRef = useRef(null)

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const markDone = async () => {
    setFinishing(true)
    try { await api.saveSettings({ setupDone: true }) } catch { /* wizard still closes */ }
    setFinishing(false)
    onDone()
  }

  const startConnect = async () => {
    setErr(''); setConnectMsg('')
    setConnectBusy(true)
    try {
      await openInstagramDirectConnect()
      // In the app, the Instagram login is now open in the system
      // browser and this screen stays put; the focus/visibility
      // refresh below flips Step 1 to "Already connected" when the
      // user returns.
      setConnectMsg(t('msgIgOpened'))
    } finally { setConnectBusy(false) }
  }

  const startFacebookConnect = async () => {
    setErr(''); setConnectMsg('')
    setConnectBusy(true)
    try {
      await openInstagramConnect()
      setConnectMsg(t('msgFbOpened'))
    } finally { setConnectBusy(false) }
  }

  // Returning from the Meta login: refresh the connection state when
  // this screen becomes visible / regains focus, no manual reload.
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

  const startImport = async () => {
    setErr(''); setJob(null)
    setImporting(true)
    try {
      const res = await api.startInstagramImport()
      const jobId = res.jobId
      pollRef.current = setInterval(async () => {
        try {
          const data = await api.getInstagramImport(jobId)
          setJob(data.job)
          if (data.job.done) {
            clearInterval(pollRef.current); pollRef.current = null
            setImporting(false)
            if (onInstagramChanged) await onInstagramChanged()
          }
        } catch (e2) {
          clearInterval(pollRef.current); pollRef.current = null
          setImporting(false)
          setErr(e2.message || t('swErrProgress'))
        }
      }, 1500)
    } catch (e2) {
      setImporting(false)
      setErr(e2.message || t('swErrStart'))
    }
  }

  const profile = job?.profile || settings?.instagramProfile || null
  const stepDefs = [
    { label: t('checkConnect'), sub: t('swStep1Sub') },
    { label: t('swStep2'), sub: t('swStep2Sub') },
    { label: t('swStep3'), sub: t('swStep3Sub') },
  ]

  return (
    <div className="wrap" style={{ maxWidth: 620, paddingTop: 40 }}>
      <div style={{ textAlign: 'center', marginBottom: 18 }}>
        <h1 style={{ fontSize: 24 }}>{t('swWelcome')}</h1>
        <p className="muted" style={{ marginTop: 6 }}>{t('swWelcomeSub')}</p>
      </div>

      <div className="steps" aria-label="Setup steps">
        {stepDefs.map((s, i) => (
          <button key={s.label} type="button" className={`step ${step === i + 1 ? 'active' : ''}`} onClick={() => setStep(i + 1)}>
            <b><span className="step-num">{i + 1}</span>{s.label}</b>
            <span className="muted small">{s.sub}</span>
          </button>
        ))}
      </div>

      {step === 1 && (
        <div className="card">
          <h2>{t('swStep1Title')}</h2>
          {settings?.instagramConnected ? (
            <p className="muted small" style={{ marginTop: 8 }}>{settings.instagramUsername ? t('swAlready').replace('{name}', settings.instagramUsername) : t('swAlreadyNoName')}</p>
          ) : (
            <p className="muted small" style={{ marginTop: 8 }}>
              {t('swStep1Body')}
            </p>
          )}
          {err && <div className="alert error">{err}</div>}
          {connectMsg && <div className="alert success">{connectMsg}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <button type="button" className="btn primary" disabled={connectBusy} onClick={startConnect}>
              {connectBusy ? t('openingIgLogin') : settings?.instagramConnected ? t('reconnectInstagram') : t('checkConnect')}
            </button>
            <button type="button" className="btn ghost" disabled={connectBusy} onClick={startFacebookConnect}>{t('connectViaFb')}</button>
            {settings?.instagramConnected && <button type="button" className="btn ghost" onClick={() => setStep(2)}>{t('swContinue')}</button>}
            <button type="button" className="btn ghost" disabled={finishing} onClick={markDone}>{t('swSkipSetup')}</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h2>{t('swStep2Title')}</h2>
          <p className="muted small" style={{ marginTop: 8 }}>
            {t('swStep2Body')}
          </p>
          <p className="muted small" style={{ marginTop: 8 }}>
            <b style={{ color: 'var(--ink)' }}>{t('swFollowersNote')}</b> {t('swFollowersNote2')}
          </p>

          {profile && (
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 16, padding: 12, border: '1px solid var(--line)', borderRadius: 12, background: 'var(--surface-2)' }}>
              {profile.profilePictureUrl && <img src={profile.profilePictureUrl} alt="" style={{ width: 52, height: 52, borderRadius: '50%', objectFit: 'cover' }} />}
              <div>
                <b>@{profile.username}</b>
                {profile.biography && <p className="muted small">{profile.biography}</p>}
                <p className="muted small">{t('swPostsOnIg').replace('{n}', profile.mediaCount)}</p>
              </div>
            </div>
          )}

          {(importing || job) && (
            <div style={{ marginTop: 16 }}>
              <p><b>{job?.status === 'done' ? t('swImportDone') : job?.status === 'error' ? t('swImportStopped') : t('swImporting')}</b></p>
              <p className="muted small" style={{ marginTop: 4 }}>
                {t(job?.fetched === 1 ? 'swImportProgressOne' : 'swImportProgress').replace('{found}', job?.fetched ?? 0).replace('{media}', job?.importedMedia ?? 0).replace('{posts}', job?.importedPosts ?? 0)}
              </p>
              {job?.message && <div className="alert success">{job.message}</div>}
              {job?.error && <div className="alert error">{job.error}</div>}
            </div>
          )}
          {err && <div className="alert error">{err}</div>}

          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            {!job?.done && (
              <button type="button" className="btn primary" disabled={importing} onClick={startImport}>
                {importing ? t('swImporting') : job ? t('swRetryImport') : t('swImportBtn')}
              </button>
            )}
            {job?.done && job?.status === 'done' && (
              <button type="button" className="btn primary" onClick={() => setStep(3)}>{t('swContinue')}</button>
            )}
            <button type="button" className="btn ghost" onClick={() => setStep(1)}>{t('backArrow')}</button>
            <button type="button" className="btn ghost" disabled={finishing} onClick={() => setStep(3)}>{t('swSkipStep')}</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card">
          <h2>{t('swStep3Title')}</h2>
          <p className="muted small" style={{ marginTop: 8 }}>{t('swStep3Body')}</p>
          <ul className="muted small" style={{ marginTop: 12, paddingLeft: 18, lineHeight: 1.9 }}>
            <li>{t('swStep3Point1')}</li>
            <li>{t('swStep3Point2')}</li>
            <li>{t('swStep3Point3')}</li>
          </ul>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <button type="button" className="btn primary" disabled={finishing} onClick={async () => { await markDone(); if (onCreateFirst) onCreateFirst() }}>{t('swStep3')}</button>
            <button type="button" className="btn ghost" onClick={() => setStep(2)}>{t('backArrow')}</button>
            <button type="button" className="btn ghost" disabled={finishing} onClick={markDone}>{t('swFinish')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
